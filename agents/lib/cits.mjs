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
  }
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
export function alsSichtung(feature) {
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

  const teile = [art.label]
  if (linie) teile.push(ziel ? `Linie ${linie} → ${ziel}` : `Linie ${linie}`)
  if (phase) teile.push(`Signal: ${phase.text}`)
  const tempo = zahl(p.speedKmh)
  if (tempo !== null && tempo > 0) teile.push(`${Math.round(tempo)} km/h`)
  if (p.denmData) teile.push('Gefahrenmeldung liegt an')
  teile.push('C-ITS über opentrafficmap.org')

  return {
    name,
    lat, lon,
    headingDeg: zahl(p.headingDeg),
    description: teile.join(' · '),
    appearance: { emoji: art.emoji || p.emoji || '📡' },
    state: {
      kind,
      label: art.label,
      moving: art.moving,
      // Only what somebody could read or filter by. The raw packet stays at the
      // source — mirroring everything would make our objects a second archive
      // of data we do not own.
      speed_kmh: tempo,
      heading_deg: zahl(p.headingDeg),
      station_id: zahl(p.stationId),
      transit_line: linie || null,
      transit_target: ziel || null,
      signal_phase: phase ? phase.text : null,
      signal_green: phase ? phase.gruen : null,
      signal_groups: phase ? phase.gruppen : null,
      hazard: p.denmData ? true : null,
      last_seen: p.lastSeen || null,
    },
  }
}
