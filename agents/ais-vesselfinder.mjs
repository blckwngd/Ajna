#!/usr/bin/env node
//
// agents/ais-vesselfinder.mjs — Schiffs-Bridge über die öffentliche
// VesselFinder-Kartenschnittstelle (Binnenschifffahrt, z. B. Rhein).
//
// ⚠ NUTZUNGSHINWEIS — bitte bewusst lesen:
//   Dieser Agent liest die INOFFIZIELLE Kartendaten-Schnittstelle von
//   vesselfinder.com (kein dokumentiertes API, keine Lizenz für Dritte). Das
//   widerspricht deren Nutzungsbedingungen und ist ausschließlich für den
//   PRIVATEN, NICHT VERÖFFENTLICHTEN Eigengebrauch gedacht. Nicht auf
//   öffentlichen Instanzen betreiben, Daten nicht weitergeben.
//   Er ist bewusst SERVERSCHONEND gebaut (60-s-Poll, kleine BBox, wenige
//   Bereiche, ehrlicher User-Agent) und enthält KEINERLEI Umgehung von
//   Sperren/Schutzmaßnahmen. Wird der Zugriff blockiert, ist Schluss —
//   dann bitte auf einen eigenen AIS-Empfänger (RTL-SDR + AIS-catcher)
//   wechseln, der ohnehin die saubere Dauerlösung ist.
//
// WARUM überhaupt: aisstream.io (agents/ais-bridge.mjs) speist sich aus
// Community-KÜSTEN-Empfängern — der Binnenrhein ist dort unabgedeckt (bei
// Koblenz: 0 Schiffe). Die Rheinschiffe senden zwar (Inland-AIS-Pflicht),
// es hört nur niemand zu. Bis ein eigener Empfänger steht, füllt dieser
// Agent die Lücke.
//
// PROTOKOLL (aus dem Karten-JS abgeleitet, Stand 2026-08):
//   GET https://www.vesselfinder.com/api/pub/mp2?bbox=<lonMin,latMin,lonMax,latMax>&zoom=<z>&mmsi=0&ref=<n>
//   Alle BBox-Werte sind GRAD × 600000 (ganzzahlig).
//   Antwort = Binär: Byte0 Magic, uint16@1 = Headerlänge Y, Records ab 4+Y.
//   Record: int16 Flags · int32 MMSI · int32 lat/600000 · int32 lon/600000 ·
//           [int16 cog/10 · int16 sog/10 — nur in höheren Zoomstufen] ·
//           int8 Typ · int8 Namenslänge · Name (ASCII).
//   Die optionalen Felder werden durch Probe-Parsing erkannt (siehe
//   parseShips): Variante wählen, die den Puffer exakt aufbraucht.
//
// Konfiguration (Env > agents/.env.ais-vf > Root-.env):
//   VF_CENTER_LAT / VF_CENTER_LON  Fallback-Zentrum (Default: Neuwied/Rhein)
//   VF_RADIUS_KM       Sichtradius je Bereich (Default: 12)
//   VF_POLL_S          Poll-Intervall (Default: 60 — bitte NICHT verringern)
//   VF_MAX_AREAS       max. Abfragen pro Poll (Default: 2)
//   VF_MAX_SHIPS       Deckel gleichzeitiger Schiffe (Default: 120)
//   VF_STALE_TIMEOUT_S Schiffe ohne Sichtung entfernen (Default: 600)
//
// Start:  node agents/ais-vesselfinder.mjs   bzw.   npm run ais-vf

import { bootAgent, envNum, envInt, publishManifest } from './lib/agent-base.mjs'
import { bboxAroundKm, centerOf, flatDistKm } from '../client/core/geoMath.js'
import { haversine, bearingRad } from '../client/core/StreetNav.js'
import { watchInterestAreas } from '../client/core/interestAreas.js'
import { simpleSetup } from './lib/setup-wizard.mjs'

const { ajna } = await bootAgent('ais-vf', {
  tag: 'ais-vf',
  setup: simpleSetup('ais-vf', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})

const CENTER_LAT = envNum('VF_CENTER_LAT', 50.4466)
const CENTER_LON = envNum('VF_CENTER_LON', 7.5971)
const RADIUS_KM  = envNum('VF_RADIUS_KM', 12)
// Untergrenze 60 s ist ABSICHT (Serverschonung) — kleinere Werte werden angehoben.
const POLL_MS    = Math.max(60, envNum('VF_POLL_S', 60)) * 1000
const MAX_AREAS  = Math.min(4, envInt('VF_MAX_AREAS', 2))
const MAX_SHIPS  = envInt('VF_MAX_SHIPS', 120)
const STALE_MS   = envNum('VF_STALE_TIMEOUT_S', 600) * 1000

const DEG = 600000                       // Koordinaten-Skalierung der API
const SOURCE = 'vesselfinder'
const ATTRIB = 'Quelle: VesselFinder (inoffizielle Kartendaten, privater Gebrauch)'
const HEADERS = {
  // Ehrlicher Browser-UA (die Schnittstelle antwortet Browsern) + Referer.
  // KEINE Rotation, keine Tarnung — nur ein normaler, seltener Abruf.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Referer': 'https://www.vesselfinder.com/',
}

console.warn('[ais-vf] ⚠ INOFFIZIELLE Quelle (VesselFinder) — nur für den privaten Eigengebrauch,')
console.warn('[ais-vf]   nicht auf öffentlichen Instanzen betreiben. Dauerlösung: eigener AIS-Empfänger.')
console.log(`[ais-vf] Zentrum ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} · Radius ${RADIUS_KM} km · Poll ${POLL_MS / 1000} s`)

await publishManifest(ajna, {
  source: SOURCE,
  agent_name: 'Schiffe (VesselFinder)',
  description: `Binnen-/Seeschiffe im Radius ${RADIUS_KM} km — ${ATTRIB}`,
  layers: [{ key: 'all', label: 'Alle Schiffe', predicate: null }],
})

// ─── Bestand adoptieren (idempotent über state.mmsi) ───────────────────────
const ships = new Map()   // mmsi → { objectId, name, lastSeenMs, inflight }
try {
  await ajna.refreshObjects()
  for (const o of ajna.getObjects()) {
    if (o?.type !== 'ship' || o?.state?.source !== SOURCE) continue
    const mmsi = String(o.state.mmsi || '')
    if (mmsi) ships.set(mmsi, { objectId: o.id, name: o.name, lastSeenMs: Date.now(), inflight: false })
  }
  console.log(`[ais-vf] ${ships.size} vorhandene Schiffe adoptiert`)
} catch (err) { console.warn(`[ais-vf] Bestands-Listing: ${err?.message || err}`) }

// ─── Binär-Parser ──────────────────────────────────────────────────────────
// Die Felder cog/sog (je int16) und die Maß-/Heading-Gruppe (5× int16) sind
// zoomabhängig optional. Statt die Zoom-Regeln nachzubauen: alle vier
// Kombinationen durchprobieren und die nehmen, die den Puffer EXAKT aufbraucht.
function parseVariant(dv, withCogSog, withDims) {
  const P = dv.byteLength
  if (P < 12) return null
  const Y = dv.getUint16(1)
  let I = 4 + Y
  const out = []
  while (I < P) {
    if (I + 16 > P) return null
    I += 2                                     // Flags
    const mmsi = dv.getInt32(I); I += 4
    const lat = dv.getInt32(I) / DEG; I += 4
    const lon = dv.getInt32(I) / DEG; I += 4
    let cog = null, sog = null
    if (withCogSog) {
      if (I + 4 > P) return null
      cog = dv.getInt16(I) / 10; I += 2
      sog = dv.getInt16(I) / 10; I += 2
    }
    if (I + 2 > P) return null
    I += 1                                     // Typ/Status
    const len = dv.getInt8(I); I += 1
    if (len < 0 || I + len > P) return null
    let name = ''
    for (let k = 0; k < len; k++) {
      const c = dv.getUint8(I + k)
      if (c < 32 || c > 126) return null       // Namen sind ASCII → sonst Fehl-Alignment
      name += String.fromCharCode(c)
    }
    I += len
    if (withDims) { if (I + 10 > P) return null; I += 10 }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
    out.push({ mmsi: String(mmsi), name: name.trim(), lat, lon, cog, sog })
  }
  return I === P ? out : null
}

function parseShips(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (const [cs, dims] of [[false, false], [true, false], [false, true], [true, true]]) {
    const r = parseVariant(dv, cs, dims)
    if (r) return r
  }
  return null
}

// ─── Schiffsdetails (Typ, Flagge, Ziel, ETA, Foto) ─────────────────────────
// Endpoint /api/pub/click/<mmsi> liefert die Popup-Daten als JSON. Diese Daten
// sind weitgehend statisch → EINE Abfrage pro Schiff, danach gecacht; nur Ziel/
// ETA veralten, dafür ein sanfter Refresh (DETAIL_TTL, wenige pro Tick).
const DETAILS = new Map()          // mmsi → { at, d }
const DETAIL_TTL = 30 * 60_000
const DETAIL_NEW_PER_TICK = 8      // neue Schiffe pro Poll anreichern
const DETAIL_REFRESH_PER_TICK = 3  // veraltete Details pro Poll auffrischen
// …ABER: derselbe Endpoint liefert auch die LIVE-Fahrtdaten (s. liveMotion).
// Fahrende Schiffe brauchen die daher jeden Tick — liegende nicht. In der
// Praxis fahren im 12-km-Umkreis 3–8 Schiffe gleichzeitig, das bleibt im
// selben Größenbereich wie die ohnehin nötigen Abfragen.
const DETAIL_LIVE_PER_TICK = 12

async function fetchDetails(mmsi) {
  const r = await fetch(`https://www.vesselfinder.com/api/pub/click/${encodeURIComponent(mmsi)}`, { headers: HEADERS })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** ISO-Ländercode ("nl") → Flaggen-Emoji (Regional-Indicator-Buchstaben). */
const flagEmoji = (a2) => (typeof a2 === 'string' && /^[a-z]{2}$/i.test(a2))
  ? String.fromCodePoint(...[...a2.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : ''

// Schiffstyp → Emoji/Farbe fürs Kartensymbol (Rest: generisches Schiff).
const TYPE_STYLE = [
  [/tanker|tank/i,             { emoji: '🛢️', color: '#e08a3c' }],
  [/passenger|cruise|ferry/i,  { emoji: '⛴️', color: '#7ac0ff' }],
  [/tug|pilot|sar|patrol/i,    { emoji: '🚤', color: '#f2c14e' }],
  [/fishing/i,                 { emoji: '🎣', color: '#6fcf97' }],
  [/dredg|special|service/i,   { emoji: '🏗️', color: '#c78ce0' }],
  [/pleasure|yacht|sailing/i,  { emoji: '⛵', color: '#9fe0d0' }],
]
const styleForType = (t) => (TYPE_STYLE.find(([re]) => re.test(String(t || '')))?.[1])
  || { emoji: '🚢', color: '#4aa3df' }

const fmtEta = (ts) => {
  if (!Number.isFinite(ts) || ts <= 0) return null
  const d = new Date(ts * 1000)
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── Bewegung: Fahrtvektor fürs Dead-Reckoning im Client ───────────────────
// Der Massen-Endpoint mp2 liefert in KEINER Zoomstufe sog/cog (z10…z17 einzeln
// nachgemessen: ab z14 kommen zwar 10 Bytes Maße/Heading dazu, aber keine
// Fahrt). Zwei Wege bleiben, in dieser Reihenfolge:
//
//  1. liveMotion() — aus dem Detail-Endpoint: `ss` = Fahrt über Grund in
//     Knoten, `cu` = Kurs über Grund, `ts` = Zeitpunkt der AIS-Meldung.
//     EXAKT und sofort gültig (kein Aufwärmen über zwei Polls), und der
//     Zeitstempel lässt den Client die Meldungslatenz mitrechnen.
//  2. motionBetween() — aus zwei aufeinanderfolgenden Positionen abgeleitet.
//     Rückfallebene für Schiffe, deren Details (noch) fehlen.
//
// Der Client extrapoliert damit frameweise zwischen den 60-s-Polls
// (state.motion → PositionSmoother, gleiche Mechanik wie bei Flugzeugen).
const MAX_SHIP_MPS = 12      // ~23 kn: darüber ist es Datensprung, nicht Fahrt
const MIN_MOVE_MPS = 0.15    // darunter: liegt fest (kein Drift durch Jitter)
const KN_TO_MPS = 0.514444
const AIS_FRESH_MS = 10 * 60_000   // ältere Meldung → Fahrtdaten nicht belastbar

// Fahrtstatus laut AIS (Feld `.ns` im Detail-JSON). Erklärt dem Betrachter,
// warum ein Schiff steht — „festgemacht" ist eine Information, kein Fehler.
const NAV_STATUS = {
  0: 'in Fahrt (Maschine)', 1: 'vor Anker', 2: 'manövrierunfähig',
  3: 'eingeschränkt manövrierfähig', 4: 'tiefgangsbeschränkt', 5: 'festgemacht',
  6: 'auf Grund', 7: 'beim Fischen', 8: 'in Fahrt (Segel)',
  11: 'im Schleppverband', 12: 'im Schleppverband', 14: 'Notruf (AIS-SART)',
  15: 'unbekannt',
}

/** Fahrtvektor direkt aus den AIS-Fahrtdaten. @returns {{v:number,trk:number,tMs:number}|null} */
function liveMotion(d, nowMs) {
  if (!d || !Number.isFinite(d.ss) || !Number.isFinite(d.cu)) return null
  const tMs = Number.isFinite(d.ts) && d.ts > 0 ? d.ts * 1000 : null
  if (tMs && nowMs - tMs > AIS_FRESH_MS) return null
  const v = d.ss * KN_TO_MPS
  if (!Number.isFinite(v) || v < 0 || v > MAX_SHIP_MPS * 2) return null
  return { v: v < MIN_MOVE_MPS ? 0 : v, trk: ((d.cu % 360) + 360) % 360, tMs: tMs || nowMs }
}

/** @returns {{v:number, trk:number}|null} */
function motionBetween(prev, lat, lon, tMs) {
  if (!prev || !Number.isFinite(prev.lat) || !Number.isFinite(prev.t)) return null
  const dt = (tMs - prev.t) / 1000
  if (dt < 5 || dt > 300) return null                 // zu eng/zu alt → unbrauchbar
  const dist = haversine(prev.lat, prev.lon, lat, lon)
  const v = dist / dt
  if (!Number.isFinite(v) || v > MAX_SHIP_MPS) return null
  if (v < MIN_MOVE_MPS) return { v: 0, trk: 0 }
  const deg = (bearingRad(prev.lat, prev.lon, lat, lon) * 180 / Math.PI + 360) % 360
  return { v, trk: deg }
}

// ─── Abruf ─────────────────────────────────────────────────────────────────
const degToYaw = deg => (deg * Math.PI / 180) - Math.PI / 2

async function fetchArea(lat, lon) {
  const b = bboxAroundKm(lat, lon, RADIUS_KM)
  const bbox = [b.lonMin, b.latMin, b.lonMax, b.latMax].map(v => Math.round(v * DEG)).join(',')
  const url = `https://www.vesselfinder.com/api/pub/mp2?bbox=${encodeURIComponent(bbox)}`
    + `&zoom=12&mmsi=0&ref=${Math.floor(Date.now() / 1000) % 100000}`
  const r = await fetch(url, { headers: HEADERS })
  if (r.status === 429 || r.status === 403) throw new Error(`HTTP ${r.status} — Zugriff gedrosselt/gesperrt, Poll aussetzen`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const list = parseShips(Buffer.from(await r.arrayBuffer()))
  if (!list) throw new Error('Binärformat nicht erkannt (Anbieter hat es vermutlich geändert)')
  return list
}

// ─── Reconcile ─────────────────────────────────────────────────────────────
let pausedUntil = 0

async function tick(areas) {
  if (Date.now() < pausedUntil) return
  const centers = areas.length
    ? areas.slice(0, MAX_AREAS).map(centerOf)
    : [{ lat: CENTER_LAT, lon: CENTER_LON }]

  const byMmsi = new Map()
  let errors = 0
  for (const c of centers) {
    try {
      for (const s of await fetchArea(c.lat, c.lon)) {
        if (!s.mmsi || byMmsi.has(s.mmsi)) continue
        s._d = flatDistKm(c.lat, c.lon, s.lat, s.lon)
        byMmsi.set(s.mmsi, s)
      }
    } catch (err) {
      errors++
      console.warn(`[ais-vf] Abruf @${c.lat.toFixed(3)},${c.lon.toFixed(3)}: ${err?.message || err}`)
      if (/gedrosselt|gesperrt/.test(String(err?.message))) pausedUntil = Date.now() + 15 * 60_000
    }
  }
  if (!byMmsi.size && errors) return          // Ausfall → Bestand NICHT abräumen

  let list = Array.from(byMmsi.values())
  if (list.length > MAX_SHIPS) { list.sort((a, b) => a._d - b._d); list = list.slice(0, MAX_SHIPS) }

  // Details nachladen: neue Schiffe zuerst (näheste bevorzugt), dazu ein paar
  // veraltete auffrischen (Ziel/ETA ändern sich unterwegs). Sequenziell mit
  // kleiner Pause — bewusst wenige Abfragen pro Minute.
  const now = Date.now()
  const needNew = list.filter(s => !DETAILS.has(s.mmsi)).sort((a, b) => a._d - b._d).slice(0, DETAIL_NEW_PER_TICK)
  const needFresh = list.filter(s => DETAILS.has(s.mmsi) && now - DETAILS.get(s.mmsi).at > DETAIL_TTL)
    .sort((a, b) => a._d - b._d).slice(0, DETAIL_REFRESH_PER_TICK)
  // Fährt das Schiff, sind Kurs/Fahrt nach 60 s veraltet → jeden Tick neu.
  // „Fährt" heißt: die letzten Fahrtdaten sagten Fahrt ODER die Position hat
  // sich seit dem vorigen Poll messbar verschoben (fängt Anfahrer ab, deren
  // Details noch auf „festgemacht" stehen).
  const underway = (s) => {
    const d = DETAILS.get(s.mmsi)?.d
    if (d && Number.isFinite(d.ss)) return d.ss >= 0.3
    const prev = ships.get(s.mmsi)?.last
    return !!(prev && haversine(prev.lat, prev.lon, s.lat, s.lon) > 15)
  }
  const needLive = list.filter(s => DETAILS.has(s.mmsi) && underway(s))
    .sort((a, b) => a._d - b._d).slice(0, DETAIL_LIVE_PER_TICK)

  const queue = []
  const seen = new Set()
  for (const s of [...needNew, ...needLive, ...needFresh]) {
    if (seen.has(s.mmsi)) continue
    seen.add(s.mmsi); queue.push(s)
  }
  for (const s of queue) {
    try {
      DETAILS.set(s.mmsi, { at: Date.now(), d: await fetchDetails(s.mmsi) })
    } catch (err) {
      DETAILS.set(s.mmsi, { at: Date.now(), d: null })   // nicht in Schleife erneut versuchen
      console.warn(`[ais-vf] Details ${s.mmsi}: ${err?.message || err}`)
    }
    await new Promise(r => setTimeout(r, 300))
  }

  let created = 0, updated = 0, failed = 0
  for (const s of list) {
    const known = ships.get(s.mmsi)
    if (known) known.lastSeenMs = now
    const name = s.name || `Schiff ${s.mmsi}`
    const d = DETAILS.get(s.mmsi)?.d || null
    const style = styleForType(d?.type)
    // Fahrtvektor: echte AIS-Fahrtdaten schlagen die Ableitung aus zwei
    // Positionen. Deren Zeitstempel (`ts`) nutzen wir nur, wenn die Details
    // AUS DIESEM Tick stammen — sonst zeigte er auf eine ältere Meldung als
    // die Position aus mp2 und der Client würde doppelt vorausrechnen.
    const derived = motionBetween(known?.last, s.lat, s.lon, now)
    if (known) known.last = { lat: s.lat, lon: s.lon, t: now }
    const live = liveMotion(d, now)
    const detailFresh = (DETAILS.get(s.mmsi)?.at ?? 0) >= now
    const motion = live || derived
    const motionT = live && detailFresh ? live.tMs : now
    const navStatus = NAV_STATUS[d?.['.ns']] ?? null
    const speedKn = live ? +(live.v / KN_TO_MPS).toFixed(1)
      : (s.sog != null ? s.sog
        : (derived && derived.v > 0 ? +(derived.v * 1.94384).toFixed(1) : null))
    const course = motion && motion.v > 0 ? motion.trk
      : (s.cog != null ? s.cog : (Number.isFinite(d?.cu) ? d.cu : null))
    const eta = fmtEta(d?.etaTS)
    const photo = d?.pic ? `https://static.vesselfinder.net/ship-photo/${d.pic}/1` : null

    const state = {
      source: SOURCE, mmsi: s.mmsi,
      ...(course != null ? { course } : {}),
      ...(speedKn != null ? { speed_kn: speedKn } : {}),
      ...(navStatus ? { nav_status: navStatus } : {}),
      // Dead-Reckoning für den Client (PositionSmoother liest state.motion):
      // zwischen den 60-s-Polls wird die Position frameweise vorausgerechnet.
      ...(motion ? { motion: { v: motion.v, trk: motion.trk, vrate: 0, t: motionT, lat0: s.lat, lon0: s.lon, alt0: 0 } } : {}),
      ...(d ? {
        ship_type: d.type || null,
        country: d.country || null,
        flag: d.a2 || null,
        destination: d.dest || null,
        eta: Number.isFinite(d.etaTS) && d.etaTS > 0 ? d.etaTS : null,
        length_m: d.al || null,
        width_m: d.aw || null,
        draught_m: Number.isFinite(d.draught) && d.draught > 0 ? d.draught / 10 : null,
        imo: d.imo || null,
        eni: d.eni || null,          // Europäische Schiffsnummer (Binnenschifffahrt)
        ais_ts: Number.isFinite(d.ts) && d.ts > 0 ? d.ts : null,   // letzte AIS-Meldung
        photo,
      } : {}),
    }

    // Beschreibung wie im VesselFinder-Popup: Typ · Flagge · Maße · Ziel/ETA ·
    // Fahrt · Kennungen — plus Quellenhinweis (private Nutzung).
    const bits = []
    if (d?.type) bits.push(d.type)
    if (d?.country) bits.push(`${flagEmoji(d.a2)} ${d.country}`.trim())
    if (d?.al && d?.aw) bits.push(`${d.al} × ${d.aw} m`)
    if (d?.dest) bits.push(`Ziel: ${d.dest}${eta ? ` (ETA ${eta})` : ''}`)
    const fahrt = speedKn == null ? (course != null ? `${Math.round(course)}°` : '')
      : (speedKn < 0.3 ? (navStatus || 'liegt fest')
        : `${speedKn.toFixed(1)} kn${course != null ? ` / ${Math.round(course)}°` : ''}`)
    if (fahrt) bits.push(fahrt)
    bits.push(`MMSI ${s.mmsi}`)
    if (d?.eni) bits.push(`ENI ${d.eni}`)
    if (d?.imo) bits.push(`IMO ${d.imo}`)
    bits.push(ATTRIB)

    const fields = {
      name, type: 'ship',
      description: bits.join(' · '),
      lat: s.lat, lon: s.lon, altitude: 0,
      ...(course != null ? { rotation: { x: 0, y: degToYaw(course), z: 0 } } : {}),
      // texture OHNE shape:"image" → Foto erscheint im Karten-Popup, in AR
      // bleibt das normale Schiffs-Objekt (kein Bild-Panel).
      appearance: { emoji: style.emoji, color: style.color, ...(photo ? { texture: photo } : {}) },
      state,
    }
    if (!known) {
      const slot = { objectId: null, name, lastSeenMs: now, inflight: true }
      ships.set(s.mmsi, slot)
      try {
        const obj = await ajna.createObject(fields)
        slot.objectId = obj.id
        created++
      } catch (err) {
        ships.delete(s.mmsi); failed++
        console.warn(`[ais-vf] create ${s.mmsi}: ${err?.response?.data?.message || err?.message || err}`)
      } finally { if (ships.has(s.mmsi)) ships.get(s.mmsi).inflight = false }
      continue
    }
    if (!known.objectId || known.inflight) continue
    known.inflight = true
    try {
      await ajna.updateObject(known.objectId, fields)
      known.name = name
      updated++
    } catch (err) {
      failed++
      console.warn(`[ais-vf] update ${s.mmsi}: ${err?.response?.data?.message || err?.message || err}`)
    } finally { known.inflight = false }
  }
  console.log(`[ais-vf] ${list.length} Schiffe (${areas.length ? `${centers.length} Bereich(e)` : 'Zentrum'}) — ${created} neu, ${updated} aktualisiert${failed ? `, ${failed} Fehler` : ''}`)
}

// ─── Stale-Cleanup ─────────────────────────────────────────────────────────
async function cleanup() {
  const cutoff = Date.now() - STALE_MS
  for (const [mmsi, s] of ships) {
    if (!s.objectId || s.inflight || s.lastSeenMs > cutoff) continue
    s.inflight = true
    try {
      await ajna.deleteObject(s.objectId)
      ships.delete(mmsi)
      console.log(`[ais-vf] − ${s.name} (${mmsi}) außer Sicht`)
    } catch (err) {
      s.inflight = false
      console.warn(`[ais-vf] delete ${mmsi}: ${err?.message || err}`)
    }
  }
}

const areaWatch = watchInterestAreas(ajna, SOURCE, { intervalMs: POLL_MS, maxAreas: MAX_AREAS }, tick)
setInterval(() => cleanup().catch(err => console.warn(`[ais-vf] cleanup: ${err?.message || err}`)), 60_000)
await areaWatch.first
console.log('[ais-vf] bereit. (Strg+C zum Beenden)')
