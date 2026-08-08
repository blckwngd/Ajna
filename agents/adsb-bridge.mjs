#!/usr/bin/env node
//
// agents/adsb-bridge.mjs — ADS-B-Flugzeug-Bridge für Ajna (OpenSky Network)
//
// Analog zur AIS-Bridge (Schiffe), aber für FLUGZEUGE aus dem OpenSky-Network.
// icao24 (Transponder-Adresse, hex) ist der stabile Identifier; type-Tag
// "aircraft".
//
// UNTERSCHIEDE zu AIS/POI/Wigle — hier steckt die eigentliche Arbeit:
//
//   • Sichtweite ~50 km (Flugzeuge sind weit oben und schnell). Interest-Areas
//     werden entsprechend GROSSZÜGIG interpretiert: der (kleine, ~500 m)
//     gefuzzte Spielerbereich wird auf einen 50-km-Radius um seine Mitte
//     aufgeblasen.
//
//   • OpenSky ist REST-Poll (kein Push) und HART rate-limitiert. Anonym nur
//     400 "Credits"/Tag (10 s Auflösung), authentifiziert 4000 (5 s). Ein
//     50-km-Kasten ist ~1,3 Quadratgrad → 1 Credit/Abruf. Darum:
//       – gepollt wird NUR, wenn Interessensbereiche aktiv sind (Spieler da),
//       – der Rest-Header X-Rate-Limit-Remaining steuert die Drosselung,
//       – bei knappem Budget / HTTP 429 wird pausiert (Retry-After beachtet).
//
//   • Auth: OpenSky nimmt seit 2025 NUR OAuth2 Client-Credentials
//     (OPENSKY_CLIENT_ID/SECRET → Token, 30 min gültig). Ohne Credentials
//     läuft es ANONYM (Default) — nur mit dem kleineren Budget.
//
//   • Weiche Bewegung trotz seltener Polls: der Agent schreibt pro Flugzeug
//     Geschwindigkeit + Kurs + Steig-/Sinkrate + Messzeitpunkt in state.adsb.
//     Der CLIENT rechnet daraus pro Frame die aktuelle Position voraus
//     (Dead-Reckoning), statt dass der Agent im Sekundentakt schreibt.
//
// Konfiguration (ENV oder .env im CWD):
//   AJNA_URL / AJNA_USER / AJNA_PASS   Ajna-Login (Pflicht — dedizierter Agent-User)
//   OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET  optional — OAuth2 (sonst anonym)
//   ADSB_CENTER_LAT / ADSB_CENTER_LON  Fallback-Zentrum (Default 50.11, 8.68 — Frankfurt)
//   ADSB_RADIUS_KM     Sichtradius in km (Default: 50)
//   ADSB_POLL_S        Poll-Intervall in s bei aktiven Bereichen (Default: 30;
//                      unter der 10-s-Auflösung anonym sinnlos)
//   ADSB_MAX_AIRCRAFT  Deckel gleichzeitiger Flugzeuge (Default: 200)
//   ADSB_MAX_AREAS     max. Abfrage-Kästen pro Poll (Default: 6; jeder = Credits)
//   ADSB_STALE_TIMEOUT_S  Flugzeuge ohne neue Sichtung entfernen (Default: 120)
//   ADSB_MIN_CREDITS   unter so vielen Rest-Credits wird pausiert (Default: 25)
//
// Start:  node agents/adsb-bridge.mjs   bzw.   npm run adsb
// Beenden: Ctrl+C.

import { bootAgent, envNum, envInt, envStr, publishManifest } from './lib/agent-base.mjs'

// Login + geschichtete .env (Env > agents/.env.adsb > Root-.env) + System-CA.
const { ajna } = await bootAgent('adsb')

const OS_CLIENT_ID     = envStr('OPENSKY_CLIENT_ID')
const OS_CLIENT_SECRET = envStr('OPENSKY_CLIENT_SECRET')
const CENTER_LAT = envNum('ADSB_CENTER_LAT', 50.11)
const CENTER_LON = envNum('ADSB_CENTER_LON', 8.68)
const RADIUS_KM  = envNum('ADSB_RADIUS_KM', 50)
const POLL_MS    = envNum('ADSB_POLL_S', 30) * 1000
const MAX_AIRCRAFT = envInt('ADSB_MAX_AIRCRAFT', 200)
const MAX_AREAS    = envInt('ADSB_MAX_AREAS', 6)
const STALE_MS   = envNum('ADSB_STALE_TIMEOUT_S', 120) * 1000
const MIN_CREDITS = envInt('ADSB_MIN_CREDITS', 25)

const OS_STATES_URL = 'https://opensky-network.org/api/states/all'
const OS_TOKEN_URL  = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

const KM_PER_DEG_LAT = 111
const AUTHED = !!(OS_CLIENT_ID && OS_CLIENT_SECRET)

console.log(`[adsb] Zentrum ${CENTER_LAT.toFixed(3)}, ${CENTER_LON.toFixed(3)} · Radius ${RADIUS_KM} km · Poll ${(POLL_MS/1000)|0} s`)
console.log(`[adsb] Auth: ${AUTHED ? 'OAuth2 (OPENSKY_CLIENT_ID gesetzt)' : 'ANONYM'} · Budget-Puffer ${MIN_CREDITS} Credits · max ${MAX_AIRCRAFT} Flugzeuge`)

if (await publishManifest(ajna, {
  source: 'opensky',
  agent_name: 'ADS-B-Bridge',
  description: `Flugzeuge via OpenSky-Network im Radius ${RADIUS_KM} km`,
  // Unbegrenztes Render-Budget: sonst zeigt der Client nur die 50 kamera-
  // nächsten (DEFAULT_RENDER_BUDGET) und cullt den Rest per Distanz — bei
  // Flugzeugen ist aber gerade die Weitsicht der Punkt. Die Gesamtzahl deckelt
  // ohnehin ADSB_MAX_AIRCRAFT.
  render_budget: 0,
  layers: [{ key: 'all', label: 'Alle Flugzeuge', predicate: null }]
})) console.log('[ajna] manifest aktualisiert')

// ─── In-Memory: icao24 → { objectId, name, lastSeenMs, inflight } ─────────
const planes = new Map()
const bootMs = Date.now()
try {
  await ajna.refreshObjects()
  for (const obj of ajna.getObjects()) {
    if (obj.type !== 'aircraft') continue
    const icao = obj.state?.icao24
    if (icao) planes.set(String(icao), { objectId: obj.id, name: obj.name, lastSeenMs: bootMs, inflight: false })
  }
  console.log(`[ajna] ${planes.size} vorhandene Flugzeuge geladen`)
} catch (err) {
  console.warn(`[ajna] initiales Listing fehlgeschlagen: ${err?.message || err}`)
}

// ─── OAuth2 (optional) ────────────────────────────────────────────────────
// Client-Credentials-Flow; Token 30 min gültig → mit Puffer vorher erneuern.
let token = null, tokenExp = 0
async function getToken() {
  if (!AUTHED) return null
  if (token && Date.now() < tokenExp - 60_000) return token
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OS_CLIENT_ID,
    client_secret: OS_CLIENT_SECRET
  })
  const r = await fetch(OS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!r.ok) throw new Error(`OAuth2 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`)
  const j = await r.json()
  token = j.access_token
  tokenExp = Date.now() + (Number(j.expires_in) || 1800) * 1000
  console.log('[adsb] OAuth2-Token erneuert')
  return token
}

// ─── Geo-Helfer ────────────────────────────────────────────────────────────
function boxAround(lat, lon, km) {
  const dLat = km / KM_PER_DEG_LAT
  const dLon = km / (KM_PER_DEG_LAT * Math.cos(lat * Math.PI / 180))
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon, cLat: lat, cLon: lon }
}
function distKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * KM_PER_DEG_LAT
  const dLon = (bLon - aLon) * KM_PER_DEG_LAT * Math.cos(aLat * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

// Aktive Interessensbereiche → 50-km-Abfragekästen um ihre Mittelpunkte.
// Nahe beieinander liegende Bereiche kollabieren auf denselben Kasten (dedupe
// über die gerundete Mitte), damit nicht jeder Spieler einen eigenen Credit
// kostet. Ohne Bereiche: Fallback-Zentrum.
async function currentBoxes() {
  let areas = []
  try { areas = await ajna.fetchInterestAreas('opensky') }
  catch (err) { console.warn(`[adsb] interest-areas: ${err?.message || err} → Fallback Zentrum`) }
  if (!areas.length) return { boxes: [boxAround(CENTER_LAT, CENTER_LON, RADIUS_KM)], fromAreas: false }

  const seen = new Set(); const boxes = []
  for (const a of areas) {
    const cLat = (a.latMin + a.latMax) / 2, cLon = (a.lonMin + a.lonMax) / 2
    // Auf ~halben Radius runden → benachbarte Spieler teilen sich einen Kasten.
    const key = `${(cLat / (RADIUS_KM / KM_PER_DEG_LAT / 2)).toFixed(0)}:${(cLon / (RADIUS_KM / KM_PER_DEG_LAT / 2)).toFixed(0)}`
    if (seen.has(key)) continue
    seen.add(key)
    boxes.push(boxAround(cLat, cLon, RADIUS_KM))
    if (boxes.length >= MAX_AREAS) break
  }
  return { boxes, fromAreas: true }
}

// ─── OpenSky-Abfrage ───────────────────────────────────────────────────────
let creditsLeft = null     // aus X-Rate-Limit-Remaining
let pausedUntil = 0        // bis wann nicht pollen (429 / Budget)

async function fetchBox(box) {
  const params = new URLSearchParams({
    lamin: String(box.latMin), lomin: String(box.lonMin),
    lamax: String(box.latMax), lomax: String(box.lonMax)
  })
  const headers = { 'User-Agent': 'ajna-adsb-bridge' }
  const tk = await getToken().catch(err => { console.warn(`[adsb] Token: ${err?.message || err}`); return null })
  if (tk) headers.Authorization = `Bearer ${tk}`

  const r = await fetch(`${OS_STATES_URL}?${params}`, { headers })
  const rem = r.headers.get('x-rate-limit-remaining')
  if (rem !== null && Number.isFinite(Number(rem))) creditsLeft = Number(rem)

  if (r.status === 429) {
    const retry = parseInt(r.headers.get('retry-after') || '0', 10)
    pausedUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000)
    throw new Error(`429 — Limit erreicht, Pause ${Math.round((pausedUntil - Date.now()) / 1000)} s`)
  }
  if (r.status === 401 && AUTHED) { token = null; throw new Error('401 — Token abgelaufen, wird erneuert') }
  if (!r.ok) throw new Error(`OpenSky ${r.status}`)

  const data = await r.json()
  return Array.isArray(data?.states) ? { states: data.states, time: data.time } : { states: [], time: null }
}

// State-Vektor (18 Felder) → handliches Objekt. Nur mit gültiger Position.
function parseState(s) {
  const lon = s[5], lat = s[6]
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return {
    icao24: String(s[0] || '').trim(),
    callsign: (s[1] || '').trim(),
    country: s[2] || '',
    lat, lon,
    altitude: Number.isFinite(s[13]) ? s[13] : (Number.isFinite(s[7]) ? s[7] : 0), // geo bevorzugt, sonst baro
    onGround: !!s[8],
    velocity: Number.isFinite(s[9]) ? s[9] : 0,       // m/s über Grund
    track: Number.isFinite(s[10]) ? s[10] : 0,        // Grad, CW von Nord
    vrate: Number.isFinite(s[11]) ? s[11] : 0,        // m/s, + = steigen
    category: Number.isFinite(s[17]) ? s[17] : null
  }
}

function describe(a) {
  const parts = [
    a.callsign ? `Flug ${a.callsign}` : `Flugzeug ${a.icao24}`,
    a.onGround ? 'am Boden' : `${Math.round(a.altitude)} m`,
    `${Math.round(a.velocity * 3.6)} km/h`,
  ]
  if (a.country) parts.push(a.country)
  parts.push(`ICAO ${a.icao24}`)
  return parts.join(' · ') + ' (Quelle: OpenSky)'
}

// AIS-Konvention: Kompass-Grad (CW von Nord) → Babylon-Yaw.
const degToYaw = deg => (deg * Math.PI / 180) - Math.PI / 2

// ─── Reconcile ─────────────────────────────────────────────────────────────
async function tick() {
  const now = Date.now()
  if (now < pausedUntil) return                       // 429/Budget-Pause
  if (creditsLeft !== null && creditsLeft < MIN_CREDITS) {
    // Budget fast leer → nicht weiter verbrennen. Bestand läuft per Client-
    // Extrapolation weiter und wird dann vom Stale-Cleanup abgeräumt.
    if (now % 300000 < POLL_MS) console.warn(`[adsb] Budget niedrig (${creditsLeft} Credits) → Poll ausgesetzt`)
    return
  }

  const { boxes, fromAreas } = await currentBoxes()

  // Alle Kästen abfragen, per icao24 vereinen. Distanz zum nächsten Kasten-
  // Zentrum merken → für den MAX_AIRCRAFT-Deckel (nächste zuerst).
  const byIcao = new Map()
  for (const box of boxes) {
    let res
    try { res = await fetchBox(box) }
    catch (err) { console.warn(`[adsb] fetch: ${err?.message || err}`); continue }
    for (const s of res.states) {
      const a = parseState(s)
      if (!a || !a.icao24) continue
      a.measuredAt = res.time ? res.time * 1000 : now
      const d = distKm(box.cLat, box.cLon, a.lat, a.lon)
      const prev = byIcao.get(a.icao24)
      if (!prev || d < prev._d) { a._d = d; byIcao.set(a.icao24, a) }
    }
  }

  let list = Array.from(byIcao.values())
  const total = list.length
  if (list.length > MAX_AIRCRAFT) {
    list.sort((x, y) => x._d - y._d)
    list = list.slice(0, MAX_AIRCRAFT)
  }
  console.log(`[adsb] ${total} Flugzeuge aus OpenSky (${fromAreas ? `${boxes.length} Bereich(e)` : 'Zentrum'})${total > list.length ? `, auf ${list.length} gedeckelt` : ''}${creditsLeft !== null ? ` · ${creditsLeft} Credits übrig` : ''}`)

  const seen = new Set()
  let created = 0, updated = 0, failed = 0
  for (const a of list) {
    seen.add(a.icao24)
    const plane = planes.get(a.icao24)
    if (plane) plane.lastSeenMs = now

    // state.adsb trägt die Extrapolations-Parameter für den Client:
    //   v = Bodengeschwindigkeit (m/s), trk = Kurs (Grad), vrate = Steigrate,
    //   t = Messzeitpunkt (epoch ms), lat0/lon0/alt0 = Position DAZU.
    const state = {
      source: 'opensky', icao24: a.icao24,
      callsign: a.callsign || null, country: a.country || null,
      on_ground: a.onGround, category: a.category,
      altitude_ref: 'msl',                 // Flughöhe ist über Meeresspiegel
      adsb: { v: a.velocity, trk: a.track, vrate: a.vrate, t: a.measuredAt, lat0: a.lat, lon0: a.lon, alt0: a.altitude }
    }
    const name = a.callsign || `✈ ${a.icao24}`

    if (!plane) {
      const slot = { objectId: null, name, lastSeenMs: now, inflight: true }
      planes.set(a.icao24, slot)
      try {
        const obj = await ajna.createObject({
          name, type: 'aircraft', description: describe(a),
          lat: a.lat, lon: a.lon, altitude: a.altitude,
          rotation: { x: 0, y: degToYaw(a.track), z: 0 },
          // Großer, gut auffindbarer Platzhalter — KEIN Modell. Karte: ✈️ +
          // Name (emojiOf gewinnt in markerIconFor). AR: schwebende Kugel, weit
          // größer als ein echtes Flugzeug (~60 m) → aus der Distanz sichtbar.
          // Eine Kugel ist symmetrisch, braucht also kein Billboard.
          appearance: {
            emoji: '✈️', color: '#39a0ff',
            ar: { shape: 'sphere', diameter: 120, opacity: 0.55 }
          },
          state
        })
        slot.objectId = obj.id
        created++
      } catch (err) {
        planes.delete(a.icao24)
        failed++
        console.warn(`[ajna] create ${a.icao24} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
      } finally {
        if (planes.has(a.icao24)) planes.get(a.icao24).inflight = false
      }
      continue
    }

    if (!plane.objectId || plane.inflight) continue
    plane.inflight = true
    try {
      const patch = { lat: a.lat, lon: a.lon, altitude: a.altitude, rotation: { x: 0, y: degToYaw(a.track), z: 0 }, state }
      if (name !== plane.name) { patch.name = name; plane.name = name }
      await ajna.updateObject(plane.objectId, patch)
      updated++
    } catch (err) {
      failed++
      console.warn(`[ajna] update ${a.icao24} fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`)
    } finally {
      plane.inflight = false
    }
  }
  if (created || failed) console.log(`[adsb] ${created} neu, ${updated} aktualisiert, ${failed} Fehler — Bestand ${planes.size}`)
}

// ─── Stale-Cleanup: Flugzeuge, die den Bereich verlassen haben / gelandet ──
async function cleanup() {
  const cutoff = Date.now() - STALE_MS
  for (const [icao, plane] of planes) {
    if (!plane.objectId || plane.inflight) continue
    if (plane.lastSeenMs > cutoff) continue
    plane.inflight = true
    try {
      await ajna.deleteObject(plane.objectId)
      planes.delete(icao)
      console.log(`[ajna] − ${plane.name} (${icao}) stale — entfernt`)
    } catch (err) {
      plane.inflight = false
      console.warn(`[ajna] cleanup ${icao} fehlgeschlagen: ${err?.message || err}`)
    }
  }
}

// ─── Loops ─────────────────────────────────────────────────────────────────
await tick().catch(err => console.warn(`[adsb] tick: ${err?.message || err}`))
setInterval(() => tick().catch(err => console.warn(`[adsb] tick: ${err?.message || err}`)), POLL_MS)
setInterval(() => cleanup().catch(err => console.warn(`[adsb] cleanup: ${err?.message || err}`)), 30_000)
console.log('[adsb] bereit. (Strg+C zum Beenden)')

// SIGINT übernimmt bootAgent; SIGTERM (pm2/systemd-Stop) zusätzlich hier.
process.on('SIGTERM', () => { console.log('[adsb] SIGTERM — exit'); process.exit(0) })
