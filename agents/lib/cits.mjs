// cits.mjs — turning OpenTrafficMap points into Ajna objects.
//
// Kept apart from the agent so it can be checked without a server and without
// the network: the translation is the part that can be wrong, a WebSocket is
// not. Same split as `wetter.mjs` next to the world context.
//
// WHAT THE SOURCE SENDS. opentrafficmap.org receives unencrypted C-ITS (ITS-G5)
// messages — the radio chatter of traffic lights, trams, buses and modern cars —
// through community receivers and publishes them as GeoJSON on a WebSocket.
// Every point carries `kind`, an emoji, a label and `lastSeen`; vehicles add
// speed and heading, traffic lights add their signal phase, and anything can
// carry a hazard warning (DENM).

/** Station kinds we know. Everything else is mirrored as it comes. */
export const KINDS = {
  traffic_light: { label: 'Ampel', emoji: '🚦', moving: false },
  rsu: { label: 'Straßenstation', emoji: '🛣️', moving: false },
  car: { label: 'PKW', emoji: '🚗', moving: true },
  light_truck: { label: 'Transporter', emoji: '🚐', moving: true },
  heavy_truck: { label: 'LKW', emoji: '🚛', moving: true },
  trailer: { label: 'Anhänger', emoji: '🚚', moving: true },
  bus: { label: 'Bus', emoji: '🚌', moving: true },
  tram: { label: 'Straßenbahn', emoji: '🚋', moving: true },
  special_vehicle: { label: 'Einsatzfahrzeug', emoji: '🚨', moving: true },
  pedestrian: { label: 'Fußgänger', emoji: '🚶', moving: true },
  unknown: { label: 'Unbekannt', emoji: '📡', moving: true },
}

/** Kinds that are a private vehicle and nobody's business but the driver's. */
export const PRIVATE_KINDS = new Set(['car', 'light_truck', 'trailer', 'pedestrian'])

/**
 * ETSI station types (`stationType`), as the standard numbers them.
 *
 * Kept next to `kind`, not instead of it: the service derives `kind` and gets
 * it right most of the time, but the raw number is what the vehicle itself
 * claimed. Where the two disagree, that disagreement is the interesting part —
 * one measured station calls itself an RSU while driving a tram route.
 */
export const STATION_TYPES = {
  0: 'unbekannt', 1: 'Fußgänger', 2: 'Radfahrer', 3: 'Moped', 4: 'Motorrad',
  5: 'PKW', 6: 'Bus', 7: 'Transporter', 8: 'LKW', 9: 'Anhänger',
  10: 'Sonderfahrzeug', 11: 'Straßenbahn', 15: 'Straßenstation',
}

/** Exterior lights a CAM can report, in the order a person would name them. */
export const LIGHT_LABELS = {
  lowBeamHeadlightsOn: 'Abblendlicht',
  highBeamHeadlightsOn: 'Fernlicht',
  daytimeRunningLightsOn: 'Tagfahrlicht',
  fogLightOn: 'Nebelscheinwerfer',
  parkingLightsOn: 'Standlicht',
  leftTurnSignalOn: 'Blinker links',
  rightTurnSignalOn: 'Blinker rechts',
  reverseLightOn: 'Rückfahrlicht',
}

/** DENM event kinds we have seen; anything else falls back to its own label. */
export const DENM_LABELS = {
  roadworks: 'Baustelle',
  accident: 'Unfall',
  trafficCondition: 'Stau',
  hazardousLocation: 'Gefahrenstelle',
  adverseWeatherCondition: 'Wetter',
  slowVehicle: 'langsames Fahrzeug',
  stationaryVehicle: 'liegengebliebenes Fahrzeug',
  emergencyVehicleApproaching: 'Einsatzfahrzeug im Anmarsch',
  dangerousSituation: 'Gefahrensituation',
  vehicleBreakdown: 'Panne',
  rescueAndRecoveryWorkInProgress: 'Bergungsarbeiten',
}

// Bewegung: Grenzen, ab denen eine Messung nicht mehr geglaubt wird.
//
// MAX_ROAD_MPS entspricht 252 km/h — darüber ist es ein Datensprung, kein
// Fahrzeug. MIN_MOVE_MPS ist die Schwelle zum Stehen: die Quelle meldet für
// haltende Fahrzeuge Werte wie 0,036 km/h, und ohne Schwelle kröche ein an der
// Ampel wartendes Auto langsam über die Kreuzung.
const MAX_ROAD_MPS = 70
const MIN_MOVE_MPS = 0.5

/**
 * Signal phases as ETSI numbers them (MovementPhaseState).
 *
 * Translated to a word, not kept as a number: a dialogue or a label has to say
 * "rot", and `3` says nothing to anyone looking at a map.
 */
export const PHASES = {
  0: 'unbekannt', 1: 'aus', 2: 'rot (Halt, dann frei)', 3: 'rot',
  4: 'rot-gelb', 5: 'grün (bedingt)', 6: 'grün',
  7: 'gelb', 8: 'gelb', 9: 'Achtung — kreuzender Verkehr',
}

/**
 * The phase of a traffic light, as one sentence.
 *
 * A junction has several signal groups and they differ — one is green while the
 * next is red. Naming them all would be noise on a label, so the summary says
 * how many are green out of how many, and the colour of the first group stands
 * for the junction. Whoever needs it exactly reads `state.cits.spat`.
 */
export function signalPhase(spat) {
  const groups = Array.isArray(spat?.groups) ? spat.groups : []
  if (!groups.length) return null
  const gruen = groups.filter(g => g.eventState === 5 || g.eventState === 6).length
  const erste = PHASES[groups[0]?.eventState] || 'unbekannt'
  return {
    text: groups.length === 1 ? erste : `${erste} · ${gruen} von ${groups.length} Gruppen grün`,
    gruen,
    gruppen: groups.length,
    endetInS: phaseEndsInS(spat, groups[0]),
  }
}

/**
 * Seconds until the first signal group changes, or null.
 *
 * HOW THE STANDARD COUNTS. ETSI stores these as `TimeMark`: tenths of a second
 * within the CURRENT OR NEXT hour, so the value wraps every 3600 s and is
 * meaningless without knowing where in the hour we are. That comes from the
 * message itself — `moy` is the minute of the year and `timeStamp` the
 * milliseconds inside that minute — so the countdown needs no clock of ours and
 * survives a receiver whose time is off by minutes.
 *
 * Three ways this returns null, all of them real: the mark is 36001 ("unknown"
 * per the standard), the message carries no time base, or the result is further
 * out than a quarter of an hour — no traffic light holds a phase that long, so
 * that is a stale message, not a long red.
 */
export function phaseEndsInS(spat, group) {
  const mark = [group?.likelyTime, group?.minEndTime, group?.maxEndTime]
    .map(Number).find(v => Number.isFinite(v) && v >= 0 && v < 36000)
  if (mark === undefined) return null
  const moy = Number(spat?.moy)
  const ms = Number(spat?.timeStamp)
  if (!Number.isFinite(moy) || !Number.isFinite(ms)) return null

  const nowInHour = (moy % 60) * 60 + ms / 1000
  let rest = mark / 10 - nowInHour
  rest = ((rest % 3600) + 3600) % 3600      // in die nächste Stunde gewickelt
  if (rest > 900) return null
  return Math.round(rest)
}

const zahl = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/**
 * Is this point worth mirroring?
 *
 * Three questions, in the order that costs least: right kind, fresh enough,
 * close enough.
 *
 * FRESHNESS MATTERS MORE THAN IT LOOKS. Three of four points in a snapshot are
 * leftovers — one measured trailer had last been heard from 110 days earlier.
 * Without this filter the world fills with ghosts that never move again.
 */
export function relevant(feature, opts = {}) {
  const {
    kinds = null, includePrivate = true, maxAgeMs = 15 * 60_000,
    center = null, radiusKm = 0, now = Date.now(),
  } = opts
  const p = feature?.properties
  const c = feature?.geometry?.coordinates
  if (!p || !Array.isArray(c)) return false
  const kind = String(p.kind || 'unknown')
  if (!includePrivate && PRIVATE_KINDS.has(kind)) return false
  if (kinds && !kinds.has(kind)) return false

  const seen = Date.parse(p.lastSeen || '')
  if (!Number.isFinite(seen) || now - seen > maxAgeMs) return false

  const lon = Number(c[0]), lat = Number(c[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (center && radiusKm > 0 && abstandKm(center.lat, center.lon, lat, lon) > radiusKm) return false
  return true
}

/**
 * The movement vector for `state.motion`, or null for anything that stands.
 *
 * WHY THIS IS NEEDED AT ALL. The bridge writes an object at most every
 * `CITS_UPDATE_INTERVAL_S` (5 s by default), while the vehicles below send ten
 * times a second. Without a vector the object would jump 70 m at a time at city
 * speed. With it, `client/core/PositionSmoother.js` computes the CURRENT
 * position every frame from the last measurement plus speed and heading — the
 * same mechanism aircraft and ships already use, which is why the field is
 * called `motion` and not `cits`.
 *
 * TWO SOURCES, IN THIS ORDER:
 *  1. The message itself (`speedKmh` + `headingDeg`). Exact and valid at once,
 *     and `lastSeen` tells the client how old the measurement already was, so
 *     the extrapolation aims at NOW and not at the moment we happened to write.
 *  2. Derived from the previous position, for stations that report neither.
 *     Needs two sightings, hence `prev`.
 *
 * A standing vehicle gets `v: 0` rather than no vector: that stops the client
 * extrapolating an old one and is the honest statement "it is here and not
 * moving".
 */
export function motionOf(feature, prev = null) {
  const p = feature?.properties || {}
  const c = feature?.geometry?.coordinates
  if (!Array.isArray(c)) return null
  const lon = Number(c[0]), lat = Number(c[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const kind = String(p.kind || 'unknown')
  const art = KINDS[kind]
  if (art && art.moving === false) return null      // Ampeln fahren nicht

  const t = Date.parse(p.lastSeen || '')
  const tMs = Number.isFinite(t) ? t : Date.now()
  const base = { lat0: lat, lon0: lon, alt0: 0, vrate: 0, t: tMs }

  const tempo = Number(p.speedKmh)
  const kurs = Number(p.headingDeg)
  if (Number.isFinite(tempo) && Number.isFinite(kurs)) {
    const v = tempo / 3.6
    if (v >= 0 && v <= MAX_ROAD_MPS) {
      return { ...base, v: v < MIN_MOVE_MPS ? 0 : v, trk: ((kurs % 360) + 360) % 360 }
    }
  }

  // Rückfallebene: aus zwei Sichtungen ableiten. Unter 2 s ist der Weg kürzer
  // als die Ortungsungenauigkeit (das ergäbe Geisterfahrten aus reinem
  // Rauschen), über 120 s war das Fahrzeug zwischendurch woanders.
  if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.t)) {
    const dt = (tMs - prev.t) / 1000
    if (dt >= 2 && dt <= 120) {
      const v = (abstandKm(prev.lat, prev.lon, lat, lon) * 1000) / dt
      if (Number.isFinite(v) && v <= MAX_ROAD_MPS) {
        if (v < MIN_MOVE_MPS) return { ...base, v: 0, trk: 0 }
        return { ...base, v, trk: kursGrad(prev.lat, prev.lon, lat, lon) }
      }
    }
  }
  return null
}

/** Compass bearing in degrees (CW from north) from one point to the next. */
export function kursGrad(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLon = r(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(r(lat2))
  const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Great-circle distance in km — small and local, no import for three lines. */
export function abstandKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

/**
 * One GeoJSON point → the fields a `Fleet` needs.
 *
 * The name is what a person would say out loud: "Straßenbahn Linie 4" beats
 * "🚋 00:01:d8". The short MAC stays as a suffix so two trams on the same line
 * can be told apart.
 */
export function alsSichtung(feature, prev = null) {
  const p = feature.properties || {}
  const [lon, lat] = feature.geometry.coordinates
  const kind = String(p.kind || 'unknown')
  const art = KINDS[kind] || { label: p.typeLabel || kind, emoji: p.emoji || '📡', moving: true }
  const kurz = p.shortMac || String(p.mac || '').slice(-8)

  // „0" ist im Quellsystem der Platzhalter für „keine Linie gesetzt" — als
  // Liniennummer vorgelesen wäre das eine Behauptung über einen Fahrplan.
  const rohLinie = String(p.transitLineDisplay || '').trim()
  const linie = rohLinie === '0' ? '' : rohLinie
  const ziel = String(p.transitTargetName || '').trim()
  const phase = signalPhase(p.trafficLightSpat)

  // Ein Name, der schon eindeutig ist, braucht die Kurz-MAC nicht — und
  // `objects.name` fasst 32 Zeichen. Lieber das Anhängsel weglassen als den
  // Namen mitten in der Adresse abschneiden.
  const eigen = String(p.trafficLightName || '').trim()
  const basis = linie ? `${art.label} ${linie}` : (eigen || art.label)
  const name = (`${basis} ${kurz}`.length <= 32 ? `${basis} ${kurz}` : basis).trim().slice(0, 32)

  // ERSTE ZEILE = WAS GESPROCHEN WIRD. Der Announcer kürzt die Antwort auf
  // „Untersuchen" für die Sprachausgabe auf 100 Zeichen (client/core/Announce.js).
  // Was dort hineingehört, ist die Kurzfassung; alles Weitere steht darunter und
  // wird nur gelesen.
  const teile = [art.label]
  if (linie) teile.push(ziel ? `Linie ${linie} → ${ziel}` : `Linie ${linie}`)
  if (phase) teile.push(`Signal: ${phase.text}`)
  const tempo = zahl(p.speedKmh)
  if (tempo !== null && tempo > 0) teile.push(`${Math.round(tempo)} km/h`)
  if (p.denmData) teile.push('Gefahrenmeldung liegt an')

  const lichter = Object.entries(LIGHT_LABELS)
    .filter(([k]) => p.exteriorLights?.[k] === true)
    .map(([, label]) => label)
  const fahrend = [
    p.brakePedalEngaged === true ? 'bremst' : null,
    p.gasPedalEngaged === true ? 'gibt Gas' : null,
    p.cruiseControlEngaged === true ? 'Tempomat aktiv' : null,
  ].filter(Boolean)
  const laenge = zahl(p.vehicleLengthM), breite = zahl(p.vehicleWidthM)
  const wagen = String(p.vehicleNumber || '').trim()
  const denmKind = String(p.denmData?.messageKind || '').trim()
  const denmText = denmKind ? (DENM_LABELS[denmKind] || p.denmData?.messageLabel || denmKind) : null
  const stationTyp = zahl(p.stationType)
  const kreuzung = zahl(p.intersectionId)
  const cert = p.certificateVerification || {}
  const hops = Number.isFinite(Number(p.maxHops)) && Number.isFinite(Number(p.remainingHops))
    ? Number(p.maxHops) - Number(p.remainingHops) : null
  const notiz = String(p.stationComments || '').trim()

  // Die Langfassung. Jede Zeile nur, wenn sie etwas zu sagen hat — eine Liste
  // aus „—" ist keine Information, sondern Beschäftigung für das Auge.
  const detail = []
  if (laenge || breite || wagen) {
    const masse = laenge && breite ? `${laenge.toFixed(1)} × ${breite.toFixed(1)} m` : null
    detail.push('Fahrzeug: ' + [masse, wagen ? `Wagen ${wagen}` : null].filter(Boolean).join(' · '))
  }
  if (lichter.length) detail.push(`Licht: ${lichter.join(', ')}`)
  if (fahrend.length) detail.push(`Fahrzustand: ${fahrend.join(', ')}`)
  if (phase) {
    // NUR wenn die Zeile mehr sagt als die Kurzfassung oben. Sonst stünde die
    // Phase zweimal wörtlich untereinander — an echten Ampeln so gesehen.
    const wann = phase.endetInS !== null ? `, wechselt in ~${phase.endetInS} s` : ''
    const wo = [kreuzung ? `Kreuzung ${kreuzung}` : null, eigen ? `„${eigen}"` : null].filter(Boolean).join(' ')
    if (wann || wo) detail.push(`${wo ? wo + ' · ' : ''}Signal ${phase.text}${wann}`)
  }
  if (denmText) detail.push(`Gefahrenmeldung: ${denmText}`)
  // `transitCity` steht AUCH an privaten Fahrzeugen — es ist die Stadt, gegen
  // deren Fahrplan der Dienst die Station abgleicht, kein Verkehrsbetrieb. An
  // einem PKW gelesen behauptet es etwas Falsches, also nur bei einer Linie.
  if (p.transitCity && linie) detail.push(`Verkehrsbetrieb: ${p.transitCity}`)
  if (stationTyp !== null) {
    const name = STATION_TYPES[stationTyp] || 'unbekannt'
    detail.push(`Stationstyp laut Sender: ${name} (${stationTyp})`)
  }
  // HERKUNFT IST HIER EIN INHALT, KEIN BEIWERK. C-ITS-Funksprüche sind
  // signiert; ob die Signatur aufgeht und über wie viele fremde Empfänger die
  // Meldung lief, entscheidet, wie ernst man sie nehmen darf.
  const funk = []
  if (p.isSigned === true) funk.push('signiert')
  if (cert.signature_valid === true) funk.push('Signatur gültig')
  else if (cert.signature_valid === false) funk.push('Signatur UNGÜLTIG')
  if (cert.chain_valid === false) funk.push('Kette nicht prüfbar')
  if (cert.status === 'unsigned') funk.push('unsigniert')
  if (hops !== null) funk.push(hops === 0 ? 'direkt empfangen' : `über ${hops} Zwischenstation${hops === 1 ? '' : 'en'}`)
  if (zahl(p.packetCount) !== null) funk.push(`${zahl(p.packetCount)} Pakete`)
  if (funk.length) detail.push(`Funk: ${funk.join(' · ')}`)
  if (notiz) detail.push(`Notiz der Betreiber: ${notiz}`)
  // Die Quelle steht am Objekt — aber UNTEN. Oben kostete sie 30 der 100
  // Zeichen, die die Sprachausgabe hergibt, und schnitt dafür ab, was den
  // Spieler wirklich angeht.
  const gehoert = p.lastSeen ? new Date(p.lastSeen) : null
  detail.push('Quelle: C-ITS über opentrafficmap.org'
    + (gehoert && !Number.isNaN(gehoert.getTime())
      ? `, zuletzt gehört ${gehoert.toISOString().slice(11, 19)} UTC` : ''))

  const kurzfassung = teile.join(' · ')
  const motion = motionOf(feature, prev)
  return {
    name,
    lat, lon,
    headingDeg: zahl(p.headingDeg),
    description: detail.length ? `${kurzfassung}\n\n${detail.join('\n')}` : kurzfassung,
    appearance: { emoji: art.emoji || p.emoji || '📡' },
    state: {
      kind,
      label: art.label,
      moving: art.moving,
      // Only what somebody could read or filter by. The raw packet stays at the
      // source — mirroring everything would make our objects a second archive
      // of data we do not own.
      //
      // DELIBERATELY NOT MIRRORED: `stationPhotos`. They are photographs of
      // real places, carry the uploader's handle and a `reviewedForPrivacy`
      // flag, and some are censored at the source. Copying them here would
      // detach them from the review that governs them.
      speed_kmh: tempo,
      heading_deg: zahl(p.headingDeg),
      station_id: zahl(p.stationId),
      station_type: stationTyp,
      transit_line: linie || null,
      transit_target: ziel || null,
      transit_city: p.transitCity || null,
      vehicle_number: wagen || null,
      vehicle_length_m: laenge,
      vehicle_width_m: breite,
      lights: lichter.length ? Object.keys(LIGHT_LABELS).filter(k => p.exteriorLights?.[k] === true) : null,
      brake: p.brakePedalEngaged === true ? true : null,
      throttle: p.gasPedalEngaged === true ? true : null,
      cruise_control: p.cruiseControlEngaged === true ? true : null,
      intersection_id: kreuzung,
      signal_phase: phase ? phase.text : null,
      signal_green: phase ? phase.gruen : null,
      signal_groups: phase ? phase.gruppen : null,
      signal_ends_in_s: phase ? phase.endetInS : null,
      hazard: p.denmData ? true : null,
      hazard_kind: denmKind || null,
      hazard_label: denmText,
      signed: p.isSigned === true ? true : null,
      signature_valid: typeof cert.signature_valid === 'boolean' ? cert.signature_valid : null,
      hops,
      packet_count: zahl(p.packetCount),
      last_seen: p.lastSeen || null,
      ...(motion ? { motion } : {}),
    },
  }
}
