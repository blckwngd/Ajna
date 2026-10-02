// aprs.mjs — turning APRS packets into Ajna objects.
//
// Kept apart from the agent so it can be checked without a network and without
// a server: the parsing is the part that can be wrong, a TCP socket is not.
// Same split as `cits.mjs` next to the C-ITS bridge.
//
// WHERE THE DATA COMES FROM. Not from the aprs.fi HTTP API — that one looks up
// single callsigns (20 per request, no wildcards, no area query) and its terms
// forbid pre-caching or collecting data, which is exactly what a mirror does.
// The source is APRS-IS, the relay network every APRS gateway feeds into, with a
// server-side radius filter. A receive-only login cannot transmit.
//
// WHAT A PACKET LOOKS LIKE:
//
//   DL1ABC-9>APRS,TCPIP*,qAC,T2GER:!5021.50N/00735.40W>088/012Unterwegs
//   `-------' `--' `----------' `-------------------------------------'
//    Absender  Ziel     Weg                  Nutzlast
//
// The destination field is not an address — for MIC-E packets it carries the
// latitude. That is the single strangest thing about this format.

/** Speed in APRS is knots; everything in Ajna is m/s. */
const KN_TO_MPS = 0.514444
const MPH_TO_MPS = 0.44704
const FT_TO_M = 0.3048

// Bewegung: Grenzen, ab denen eine Meldung nicht mehr geglaubt wird.
// 360 m/s liegt über jedem Segelflugzeug und unter jedem Datensprung;
// 0,5 m/s ist die Schwelle zum Stehen (ein Wetterbaken-„Kurs" ist Rauschen).
const MAX_MPS = 360
const MIN_MOVE_MPS = 0.5

/**
 * APRS symbols we translate, as table id + symbol code.
 *
 * A symbol is TWO characters: the table (`/` primary, `\` alternate, or a
 * letter/digit as an overlay) and the code. Only the code is listed here,
 * because the alternate table rarely changes what a thing IS — a car stays a
 * car. Unknown symbols fall back to a radio mast, which is honest: all we then
 * know is that something transmitted.
 */
export const SYMBOLS = {
  '>': { label: 'Fahrzeug', emoji: '🚗', moving: true },
  '<': { label: 'Motorrad', emoji: '🏍️', moving: true },
  'b': { label: 'Fahrrad', emoji: '🚲', moving: true },
  'j': { label: 'Geländewagen', emoji: '🚙', moving: true },
  'k': { label: 'Lieferwagen', emoji: '🚐', moving: true },
  'u': { label: 'Lastzug', emoji: '🚛', moving: true },
  'v': { label: 'Kleinbus', emoji: '🚐', moving: true },
  'R': { label: 'Wohnmobil', emoji: '🚍', moving: true },
  '=': { label: 'Zug', emoji: '🚆', moving: true },
  'f': { label: 'Feuerwehr', emoji: '🚒', moving: true },
  'a': { label: 'Rettungswagen', emoji: '🚑', moving: true },
  'P': { label: 'Polizei', emoji: '🚓', moving: true },
  's': { label: 'Boot', emoji: '🚤', moving: true },
  'Y': { label: 'Segelyacht', emoji: '⛵', moving: true },
  '^': { label: 'Flugzeug', emoji: '✈️', moving: true },
  "'": { label: 'Kleinflugzeug', emoji: '🛩️', moving: true },
  'g': { label: 'Segelflugzeug', emoji: '🛫', moving: true },
  'X': { label: 'Hubschrauber', emoji: '🚁', moving: true },
  'O': { label: 'Ballon', emoji: '🎈', moving: true },
  '[': { label: 'Mensch', emoji: '🚶', moving: true },
  '_': { label: 'Wetterstation', emoji: '🌡️', moving: false },
  '#': { label: 'Digipeater', emoji: '📡', moving: false },
  '&': { label: 'Gateway', emoji: '🛰️', moving: false },
  'r': { label: 'Relais', emoji: '📶', moving: false },
  '-': { label: 'Station', emoji: '🏠', moving: false },
  'I': { label: 'Station', emoji: '🖧', moving: false },
  'y': { label: 'Station', emoji: '🏠', moving: false },
  'W': { label: 'Wetterdienst', emoji: '🌦️', moving: false },
}

const UNBEKANNT = { label: 'APRS-Station', emoji: '📻', moving: false }

/** What a symbol means, with a fallback that claims nothing. */
export function symbolInfo(code) {
  return SYMBOLS[code] || UNBEKANNT
}

// ─── Frame ────────────────────────────────────────────────────────────────

/**
 * Split `SRC>DST,PATH:payload` into its parts.
 *
 * The first colon ends the header — a colon inside the payload (messages use
 * one) must not confuse it. A line from APRS-IS starting with `#` is a server
 * comment and no packet at all.
 */
export function parseFrame(line) {
  const text = String(line || '').replace(/[\r\n]+$/, '')
  if (!text || text.startsWith('#')) return null
  const doppel = text.indexOf(':')
  if (doppel < 1) return null
  const kopf = text.slice(0, doppel)
  const payload = text.slice(doppel + 1)
  if (!payload) return null

  const pfeil = kopf.indexOf('>')
  if (pfeil < 1) return null
  const srccall = kopf.slice(0, pfeil).toUpperCase()
  const rest = kopf.slice(pfeil + 1).split(',')
  const dstcall = (rest[0] || '').toUpperCase()
  if (!srccall || !dstcall) return null
  return { srccall, dstcall, path: rest.slice(1), payload }
}

// ─── Koordinaten ──────────────────────────────────────────────────────────

/**
 * `4903.50N` / `00735.40W` → decimal degrees.
 *
 * AMBIGUITY IS PART OF THE FORMAT: a station may blank out trailing minute
 * digits with spaces to say "I am not telling you that precisely". Treating
 * those spaces as zeros is the conventional reading, and the number of blanks
 * comes back so a caller can tell a street-level fix from a town-level one.
 */
export function parseCoord(text, istLaenge) {
  const gradLen = istLaenge ? 3 : 2
  const roh = String(text || '')
  if (roh.length !== gradLen + 6) return null
  const hemi = roh[gradLen + 5]
  const grad = Number(roh.slice(0, gradLen))
  const minRoh = roh.slice(gradLen, gradLen + 5)       // "MM.mm"
  const unscharf = (minRoh.match(/ /g) || []).length
  const min = Number(minRoh.replace(/ /g, '0'))
  if (!Number.isFinite(grad) || !Number.isFinite(min) || min >= 60) return null
  let wert = grad + min / 60
  if (hemi === 'S' || hemi === 'W') wert = -wert
  else if (hemi !== 'N' && hemi !== 'E') return null
  if (istLaenge ? Math.abs(wert) > 180 : Math.abs(wert) > 90) return null
  return { wert, unscharf }
}

/** Base-91 as APRS compresses it: each character carries 0..90. */
export function base91(text) {
  let wert = 0
  for (const z of String(text)) {
    const c = z.charCodeAt(0) - 33
    if (c < 0 || c > 90) return null
    wert = wert * 91 + c
  }
  return wert
}

// ─── Nutzlast-Formen ──────────────────────────────────────────────────────

/** `nnn/nnn` right after the symbol — course in degrees, speed in knots. */
function kursTempo(text) {
  const m = /^(\d{3})\/(\d{3})/.exec(text || '')
  if (!m) return {}
  const kurs = Number(m[1]), knoten = Number(m[2])
  return {
    course: kurs >= 1 && kurs <= 360 ? (kurs === 360 ? 0 : kurs) : null,
    speed: Number.isFinite(knoten) ? knoten * KN_TO_MPS : null,
    rest: (text || '').slice(7),
  }
}

/** `/A=001234` anywhere in the comment — altitude in FEET. */
function hoeheAusKommentar(text) {
  const m = /\/A=(-?\d{6})/.exec(text || '')
  if (!m) return { altitude: null, comment: text }
  return {
    altitude: Number(m[1]) * FT_TO_M,
    comment: String(text).replace(m[0], '').trim(),
  }
}

/** Uncompressed position: `4903.50N/00735.40W>` plus extensions. */
function parseUncompressed(text) {
  if (text.length < 19) return null
  const lat = parseCoord(text.slice(0, 8), false)
  const lon = parseCoord(text.slice(9, 18), true)
  if (!lat || !lon) return null
  const tabelle = text[8]
  const symbol = text[18]
  const nach = text.slice(19)

  // AN EINER WETTERSTATION IST `220/004` WIND, NICHT FAHRT. Dieselben sieben
  // Zeichen an derselben Stelle bedeuten je nach Symbol etwas anderes — das
  // steht so in der Spezifikation. Sie als Kurs und Tempo zu lesen hätte die
  // Winddaten verschluckt und der Station eine Fahrtrichtung angedichtet.
  if (symbol === '_') {
    return {
      lat: lat.wert, lon: lon.wert, unscharf: lat.unscharf,
      symbolTable: tabelle, symbol, course: null, speed: null, comment: nach,
    }
  }

  const ks = kursTempo(nach)
  return {
    lat: lat.wert, lon: lon.wert, unscharf: lat.unscharf,
    symbolTable: tabelle, symbol,
    course: ks.course ?? null, speed: ks.speed ?? null,
    comment: (ks.rest !== undefined ? ks.rest : nach),
  }
}

/**
 * Compressed position: 13 characters of base-91.
 *
 * Detected by the first character not being a digit — an uncompressed report
 * always starts with the latitude's degrees. That test comes straight from the
 * specification and is the only reliable one, because both forms share the same
 * data type characters.
 */
function parseCompressed(text) {
  if (text.length < 13) return null
  const y = base91(text.slice(1, 5))
  const x = base91(text.slice(5, 9))
  if (y === null || x === null) return null
  const lat = 90 - y / 380926
  const lon = -180 + x / 190463
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null

  const c = text[10], s = text[11], typ = text[12]
  let course = null, speed = null, altitude = null
  if (c === '{') {
    // Radio range, not movement — nothing to extrapolate from.
  } else if (c >= '!' && c <= 'z') {
    // Bit 4 of the type byte marks the two bytes as a GPS altitude instead.
    const istHoehe = ((typ.charCodeAt(0) - 33) & 0b00110000) === 0b00100000
    if (istHoehe) {
      const cs = base91(c + s)
      if (cs !== null) altitude = Math.pow(1.002, cs) * FT_TO_M
    } else {
      // Im komprimierten Format sind 0° einfach Nord — anders als bei
      // `nnn/nnn`, wo 000 „unbekannt" heisst und 360 für Nord steht.
      course = ((c.charCodeAt(0) - 33) * 4) % 360
      speed = (Math.pow(1.08, s.charCodeAt(0) - 33) - 1) * KN_TO_MPS
    }
  }
  return {
    lat, lon, unscharf: 0,
    symbolTable: text[0], symbol: text[9],
    course, speed, altitude,
    comment: text.slice(13),
  }
}

/**
 * MIC-E: the latitude hides in the DESTINATION callsign.
 *
 * This is the format most mobile trackers use, so leaving it out would mean
 * losing exactly the stations that move. The destination's six characters each
 * carry one latitude digit plus a flag bit; three of its positions also decide
 * north/south, the longitude's +100° offset and east/west. The information
 * field then carries longitude, speed and course as bytes offset by 28.
 *
 * WARNING: unlike every other branch here, this one has NOT yet been checked
 * against packets from the air — only against the worked examples in the
 * specification. See agents/lib/aprs.test.mjs.
 */
function parseMicE(payload, dstcall) {
  if (payload.length < 9 || dstcall.length < 6) return null
  const ziel = dstcall.slice(0, 6)

  let ziffern = ''
  for (const z of ziel) {
    if (z >= '0' && z <= '9') ziffern += z
    else if (z >= 'A' && z <= 'J') ziffern += String.fromCharCode(z.charCodeAt(0) - 17) // 'A'→'0'
    else if (z >= 'P' && z <= 'Y') ziffern += String.fromCharCode(z.charCodeAt(0) - 32) // 'P'→'0'
    else if (z === 'K' || z === 'L' || z === 'Z') ziffern += ' '
    else return null
  }
  const nord = ziel[3] >= 'P' && ziel[3] <= 'Z'
  const plus100 = ziel[4] >= 'P' && ziel[4] <= 'Z'
  const west = ziel[5] >= 'P' && ziel[5] <= 'Z'

  const latText = ziffern.slice(0, 4) + '.' + ziffern.slice(4, 6) + (nord ? 'N' : 'S')
  const lat = parseCoord(latText, false)
  if (!lat) return null

  const b = (i) => payload.charCodeAt(i) - 28
  let grad = b(1)
  if (plus100) grad += 100
  if (grad >= 180 && grad <= 189) grad -= 80
  else if (grad >= 190 && grad <= 199) grad -= 190
  let min = b(2); if (min >= 60) min -= 60
  const hundertstel = b(3)
  if (grad < 0 || grad > 179 || min < 0 || hundertstel < 0) return null
  let lon = grad + (min + hundertstel / 100) / 60
  if (west) lon = -lon

  const sp = b(4), dc = b(5), se = b(6)
  let knoten = sp * 10 + Math.floor(dc / 10)
  let kurs = (dc % 10) * 100 + se
  if (knoten >= 800) knoten -= 800
  if (kurs >= 400) kurs -= 400

  const kommentar = payload.slice(9)
  const hoehe = /^(.{3})\}/.exec(kommentar)
  let altitude = null, rest = kommentar
  if (hoehe) {
    const v = base91(hoehe[1])
    if (v !== null) { altitude = v - 10000; rest = kommentar.slice(4) }
  }

  return {
    lat: lat.wert, lon, unscharf: lat.unscharf,
    symbolTable: payload[8], symbol: payload[7],
    course: kurs > 0 && kurs <= 360 ? (kurs === 360 ? 0 : kurs) : null,
    speed: knoten * KN_TO_MPS,
    altitude, comment: rest,
  }
}

/**
 * Weather data appended to a report: `.../...g...t...r...p...P...h..b.....`
 *
 * Fahrenheit, miles per hour and hundredths of an inch — the format is American
 * through and through. Converted here, once, so nothing downstream has to know.
 */
export function parseWeather(text) {
  const roh = String(text || '')
  const zahl = (re, teiler = 1) => {
    const m = re.exec(roh)
    if (!m || /^\.+$/.test(m[1])) return null
    const v = Number(m[1])
    return Number.isFinite(v) ? v / teiler : null
  }
  const f = zahl(/t(-?\d{2,3})/)
  const w = {
    wind_dir: zahl(/^(\d{3})\//),
    wind_mps: (() => { const v = zahl(/^\d{3}\/(\d{3})/); return v === null ? null : v * MPH_TO_MPS })(),
    gust_mps: (() => { const v = zahl(/g(\d{3})/); return v === null ? null : v * MPH_TO_MPS })(),
    temp_c: f === null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10,
    humidity: (() => { const v = zahl(/h(\d{2})/); return v === 0 ? 100 : v })(),
    pressure_hpa: zahl(/b(\d{5})/, 10),
    rain_1h_mm: (() => { const v = zahl(/r(\d{3})/); return v === null ? null : Math.round(v * 0.254 * 10) / 10 })(),
  }
  return Object.values(w).some(v => v !== null) ? w : null
}

/**
 * One APRS packet → everything we understood, or null.
 *
 * The data type character comes first and decides the shape. Everything we do
 * not place is dropped rather than guessed at — a wrong position on a map is
 * worse than a missing one.
 */
export function parsePacket(line) {
  const frame = parseFrame(line)
  if (!frame) return null
  const { payload, dstcall } = frame
  const typ = payload[0]

  let pos = null
  let art = 'position'
  let name = frame.srccall

  if (typ === '`' || typ === "'" || typ === '\x1c' || typ === '\x1d') {
    pos = parseMicE(payload, dstcall)
    art = 'mic-e'
  } else if (typ === '!' || typ === '=') {
    pos = positionsRumpf(payload.slice(1))
  } else if (typ === '@' || typ === '/') {
    // Mit Zeitstempel: sieben Zeichen, die wir überspringen. Für die Frische
    // zählt der EMPFANG — ein Sender mit falsch gestellter Uhr soll nicht
    // dafür sorgen, dass sein Objekt sofort als veraltet gilt.
    pos = positionsRumpf(payload.slice(8))
  } else if (typ === ';') {
    // Objekt: 9 Zeichen Name, dann `*` (lebend) oder `_` (gelöscht), dann Zeit.
    const objName = payload.slice(1, 10).trim()
    const lebt = payload[10] === '*'
    if (!objName) return null
    pos = positionsRumpf(payload.slice(18))
    art = 'object'
    name = objName
    if (!lebt) return { ...frame, type: 'object', name, deleted: true }
  } else if (typ === ')') {
    // Item: Name variabel, endet an `!` oder `_`.
    const m = /^\)([^!_]{3,9})([!_])/.exec(payload)
    if (!m) return null
    pos = positionsRumpf(payload.slice(m[0].length))
    art = 'item'
    name = m[1]
    if (m[2] === '_') return { ...frame, type: 'item', name, deleted: true }
  } else {
    return null                       // Status, Nachricht, Telemetrie, Mist
  }
  if (!pos) return null

  const h = hoeheAusKommentar(pos.comment)
  const wetter = pos.symbol === '_' ? parseWeather(pos.comment) : null
  return {
    ...frame,
    type: art,
    name,
    lat: pos.lat,
    lon: pos.lon,
    unscharf: pos.unscharf,
    symbolTable: pos.symbolTable,
    symbol: pos.symbol,
    course: pos.course ?? null,
    speed: pos.speed ?? null,
    altitude: pos.altitude ?? h.altitude ?? null,
    comment: (wetter ? '' : String(h.comment || '')).trim(),
    weather: wetter,
  }
}

/** Compressed or uncompressed? Decided by the first character, per the spec. */
function positionsRumpf(text) {
  if (!text) return null
  return /^\d/.test(text) ? parseUncompressed(text) : parseCompressed(text)
}

// ─── Filter ───────────────────────────────────────────────────────────────

/** Great-circle distance in km. */
export function abstandKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

/**
 * Is this packet worth mirroring?
 *
 * The radius is checked here as well, although APRS-IS already filters: its
 * filter works on whole degrees of a bounding box, not a circle, and a second
 * source (a local receiver) would not filter at all.
 */
export function relevant(parsed, opts = {}) {
  const { center = null, radiusKm = 0, maxUnscharf = 2, symbols = null } = opts
  if (!parsed || parsed.deleted) return false
  if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)) return false
  if (parsed.lat === 0 && parsed.lon === 0) return false   // "noch kein Fix"
  // Eine Station, die ihre Minuten ausblendet, steht bis zu 18 km daneben. Als
  // Punkt in der Welt behauptet das eine Genauigkeit, die es nicht gibt.
  if (parsed.unscharf > maxUnscharf) return false
  if (symbols && !symbols.has(parsed.symbol)) return false
  if (center && radiusKm > 0 && abstandKm(center.lat, center.lon, parsed.lat, parsed.lon) > radiusKm) return false
  return true
}

// ─── Übersetzung ──────────────────────────────────────────────────────────

/**
 * One parsed packet → the fields a `Fleet` needs.
 *
 * The first line of the description is what gets spoken (the announcer cuts at
 * 100 characters), everything else is for reading — same rule as in `cits.mjs`.
 */
export function alsSichtung(parsed, now = Date.now()) {
  const info = symbolInfo(parsed.symbol)
  const name = String(parsed.name || parsed.srccall).slice(0, 32)
  const tempo = Number.isFinite(parsed.speed) ? parsed.speed : null
  const w = parsed.weather

  const kopf = [info.label]
  if (parsed.type === 'object') kopf.push('Objekt')
  if (w) {
    const teile = []
    if (w.temp_c !== null) teile.push(`${w.temp_c} °C`)
    if (w.humidity !== null) teile.push(`${w.humidity} % rF`)
    if (w.wind_mps !== null) teile.push(`Wind ${Math.round(w.wind_mps)} m/s`)
    if (teile.length) kopf.push(teile.join(', '))
  } else if (tempo !== null && tempo >= MIN_MOVE_MPS) {
    kopf.push(`${Math.round(tempo * 3.6)} km/h`)
  }
  if (!w && parsed.comment) kopf.push(parsed.comment)

  const detail = []
  if (parsed.name !== parsed.srccall) detail.push(`Gesendet von: ${parsed.srccall}`)
  if (parsed.altitude !== null) detail.push(`Höhe: ${Math.round(parsed.altitude)} m`)
  if (w) {
    const zeilen = []
    if (w.wind_dir !== null && w.wind_mps !== null) {
      zeilen.push(`Wind ${Math.round(w.wind_mps)} m/s aus ${w.wind_dir}°`
        + (w.gust_mps !== null ? `, Spitzen ${Math.round(w.gust_mps)} m/s` : ''))
    }
    if (w.pressure_hpa !== null) zeilen.push(`Luftdruck ${w.pressure_hpa} hPa`)
    if (w.rain_1h_mm !== null) zeilen.push(`Regen letzte Stunde ${w.rain_1h_mm} mm`)
    if (zeilen.length) detail.push(`Wetter: ${zeilen.join(' · ')}`)
    if (parsed.comment) detail.push(parsed.comment)
  }
  if (parsed.unscharf > 0) {
    // Ehrlich bleiben: die Station hat die Stellen selbst ausgeblendet.
    detail.push(`Position auf ${parsed.unscharf === 1 ? '1,8 km' : '18 km'} genau angegeben`)
  }
  const weg = parsed.path.filter(p => p && !p.startsWith('q') && p !== 'TCPIP*')
  if (weg.length) detail.push(`Weg: ${weg.join(' → ')}`)
  // WANN GEHÖRT — bei APRS wichtiger als bei allen anderen Quellen. Eine feste
  // Station bakt alle 20 bis 30 Minuten, ein Fahrzeug alle ein bis fünf. Ein
  // Punkt auf der Karte ohne diese Angabe behauptet Gegenwart, die er nicht hat.
  const gehoert = new Date(now)
  detail.push(`Quelle: APRS über APRS-IS, Symbol ${parsed.symbolTable}${parsed.symbol}`
    + `, gehört ${gehoert.toISOString().slice(11, 19)} UTC`)

  const kurz = kopf.join(' · ').slice(0, 100)
  return {
    name,
    lat: parsed.lat,
    lon: parsed.lon,
    altitude: parsed.altitude ?? 0,
    headingDeg: parsed.course,
    description: `${kurz}\n\n${detail.join('\n')}`,
    appearance: { emoji: info.emoji },
    state: {
      callsign: parsed.srccall,
      label: info.label,
      moving: info.moving,
      aprs_type: parsed.type,
      symbol: `${parsed.symbolTable}${parsed.symbol}`,
      course_deg: parsed.course,
      speed_mps: tempo === null ? null : Math.round(tempo * 100) / 100,
      altitude_m: parsed.altitude === null ? null : Math.round(parsed.altitude),
      comment: parsed.comment || null,
      position_vague: parsed.unscharf || null,
      ...(w ? { weather: w } : {}),
      ...(motionOf(parsed, now) ? { motion: motionOf(parsed, now) } : {}),
    },
  }
}

/**
 * The movement vector for `state.motion`, or null for anything that stands.
 *
 * APRS beacons are sparse — a mobile station reports every one to five minutes,
 * a fixed one every twenty. Without a vector a car would jump a kilometre at a
 * time; with it the client computes the current position every frame
 * (`client/core/PositionSmoother.js`), as it already does for aircraft, ships
 * and C-ITS.
 *
 * A station that reports a position but no course is left without a vector
 * rather than given `v: 0`: unlike C-ITS, "no course field" here means "did not
 * say", not "standing still".
 */
export function motionOf(parsed, now = Date.now()) {
  const info = symbolInfo(parsed?.symbol)
  if (!info.moving) return null
  const v = parsed?.speed
  const trk = parsed?.course
  if (!Number.isFinite(v) || v < 0 || v > MAX_MPS) return null
  if (!Number.isFinite(trk)) return null
  return {
    v: v < MIN_MOVE_MPS ? 0 : v,
    trk: ((trk % 360) + 360) % 360,
    vrate: 0,
    lat0: parsed.lat,
    lon0: parsed.lon,
    alt0: Number.isFinite(parsed.altitude) ? parsed.altitude : 0,
    t: now,
  }
}
