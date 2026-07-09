// server/presence.js — Interest-Areas (datenschutzfreundliche Präsenz)
//
// Spieler veröffentlichen einen UNSCHARFEN Interessensbereich (BBOX), damit
// Agents Daten nur dort liefern, wo wirklich jemand ist (Last sparen) — statt
// eines fixen konfigurierten Zentrums.
//
// PRIVACY-GRENZE liegt HIER, nicht in PB-Rules:
//   • Roh-Bereiche (mit User-Bezug) liegen NUR im RAM dieses Servers, werden
//     nie persistiert, nie als PB-Collection abfragbar, keine Historie.
//   • Agents lesen NICHT einzelne Bereiche, sondern ein GEMERGTES, grob
//     gerastertes, IDENTITÄTSFREIES Set von BBOXen. Es ist daher egal, dass
//     jeder ein Agent-Konto anlegen kann — der GET liefert allen denselben
//     anonymisierten Aggregat-Stand, kein einzelner User ist herauslesbar.
//   • Zusätzlich fuzzt der Client seine Position vor dem Senden (Grid + 500 m
//     BBOX), und ein Opt-out-Schalter unterbindet die Übermittlung komplett.
//
// Endpoints (unter /ajnaapi/, gewired in server/index.js):
//   POST   /ajnaapi/interest-areas   Body { bbox:{latMin,latMax,lonMin,lonMax}, sources:[...] }
//   DELETE /ajnaapi/interest-areas   (Opt-out / Logout: eigenen Eintrag löschen)
//   GET    /ajnaapi/interest-areas?source=overpass   → anonymisierte BBOX-Liste

import PocketBase from 'pocketbase'

const PB_URL = process.env.AJNA_PB_URL || 'http://127.0.0.1:8090'
const TTL_MS  = parseInt(process.env.AJNA_PRESENCE_TTL_MS || '180000', 10) // 3 min
const GRID_M  = parseInt(process.env.AJNA_PRESENCE_GRID_M || '250', 10)    // Ausgabe-Raster
const MAX_BBOX_DEG = 0.02   // ~2 km Kantenlänge-Cap (Missbrauch/zu-genau verhindern)

// In-Memory: userId → { bbox, sources, expiresAt }. Bewusst flüchtig.
const areas = new Map()

async function authUserId(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  try {
    const pb = new PocketBase(PB_URL)
    pb.authStore.save(token, null)
    await pb.collection('users').authRefresh()
    // SDK 0.21 füllt authStore.model, neuere .record — beides abdecken.
    const rec = pb.authStore.record || pb.authStore.model
    return rec?.id || null
  } catch { return null }
}

function pruneExpired(now = Date.now()) {
  for (const [k, v] of areas) if (v.expiresAt <= now) areas.delete(k)
}

const finite = v => typeof v === 'number' && Number.isFinite(v)
function validBbox(b) {
  return b && finite(b.latMin) && finite(b.latMax) && finite(b.lonMin) && finite(b.lonMax) &&
    b.latMax > b.latMin && b.lonMax > b.lonMin &&
    (b.latMax - b.latMin) <= MAX_BBOX_DEG && (b.lonMax - b.lonMin) <= MAX_BBOX_DEG
}

export function mountPresenceRoutes(app) {
  // ── Publish / Refresh des eigenen Bereichs ──────────────────────────────
  app.post('/ajnaapi/interest-areas', async (req, res) => {
    const uid = await authUserId(req)
    if (!uid) return res.status(401).json({ error: 'auth token required' })

    const { bbox, sources } = req.body || {}
    if (!validBbox(bbox)) return res.status(400).json({ error: 'gültige bbox erforderlich (max ~2 km)' })
    const srcs = Array.isArray(sources)
      ? Array.from(new Set(sources.filter(s => typeof s === 'string'))).slice(0, 32)
      : []

    areas.set(uid, {
      bbox: { latMin: bbox.latMin, latMax: bbox.latMax, lonMin: bbox.lonMin, lonMax: bbox.lonMax },
      sources: srcs,
      expiresAt: Date.now() + TTL_MS
    })
    res.json({ ok: true, ttlMs: TTL_MS })
  })

  // ── Opt-out / Logout: eigenen Eintrag entfernen ─────────────────────────
  app.delete('/ajnaapi/interest-areas', async (req, res) => {
    const uid = await authUserId(req)
    if (!uid) return res.status(401).json({ error: 'auth token required' })
    areas.delete(uid)
    res.json({ ok: true })
  })

  // ── Anonymisiertes Aggregat für Agents ──────────────────────────────────
  // Liefert grob gerasterte, deduplizierte BBOXen (kein User-Bezug, keine
  // Anzahl). Optional auf eine `source` gefiltert: nur Bereiche von Spielern,
  // die diesen Agent eingeblendet haben.
  app.get('/ajnaapi/interest-areas', async (req, res) => {
    const uid = await authUserId(req)
    if (!uid) return res.status(401).json({ error: 'auth token required' })

    pruneExpired()
    const source = req.query.source ? String(req.query.source) : null
    const g = GRID_M / 111000   // Rasterschritt in Grad (Breite)
    const snap = v => Math.floor(v / g) * g

    const uniq = new Map()
    for (const a of areas.values()) {
      if (source && !a.sources.includes(source)) continue
      // Ganze BBOX aufs Raster snappen → nahe Spieler kollabieren auf dieselbe
      // Zelle, Identität + Feinposition gehen verloren.
      const sb = {
        latMin: snap(a.bbox.latMin), latMax: snap(a.bbox.latMax) + g,
        lonMin: snap(a.bbox.lonMin), lonMax: snap(a.bbox.lonMax) + g
      }
      const key = `${sb.latMin.toFixed(5)}|${sb.lonMin.toFixed(5)}|${sb.latMax.toFixed(5)}|${sb.lonMax.toFixed(5)}`
      if (!uniq.has(key)) uniq.set(key, sb)
    }
    res.json({ source, gridM: GRID_M, ttlMs: TTL_MS, areas: Array.from(uniq.values()) })
  })

  // ── Debug: rohe aktive Bereiche (ohne User-ID) zur Fehlersuche ──────────
  // Zeigt Zentrum, BBOX, sources und Rest-TTL jedes aktiven Eintrags — so lässt
  // sich prüfen, ob überhaupt publiziert wird und ob die Quelle (z. B.
  // "world-director") mitgeschickt wird. Nur mit AJNA_PRESENCE_DEBUG=1 aktiv
  // (deanonymisiert teilweise → nicht für den Normalbetrieb).
  if (process.env.AJNA_PRESENCE_DEBUG === '1') {
    app.get('/ajnaapi/interest-areas/debug', async (req, res) => {
      const uid = await authUserId(req)
      if (!uid) return res.status(401).json({ error: 'auth token required' })
      pruneExpired()
      const now = Date.now()
      const list = Array.from(areas.values()).map(a => ({
        center: { lat: (a.bbox.latMin + a.bbox.latMax) / 2, lon: (a.bbox.lonMin + a.bbox.lonMax) / 2 },
        bbox: a.bbox,
        sources: a.sources,
        expiresInMs: a.expiresAt - now
      }))
      res.json({ count: list.length, ttlMs: TTL_MS, now, areas: list })
    })
    console.log('[presence] DEBUG aktiv: GET /ajnaapi/interest-areas/debug')
  }

  console.log(`[presence] mounted /ajnaapi/interest-areas (ttl: ${TTL_MS} ms, grid: ${GRID_M} m, in-memory)`)
}
