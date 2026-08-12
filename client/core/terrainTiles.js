// client/core/terrainTiles.js — Geländehöhen aus Terrarium-Kacheln.
//
// QUELLE: das offene "Terrain Tiles"-Set auf AWS (Mapzen-Erbe, gespeist aus
// SRTM/Copernicus/nationalen DGMs). Kostenlos, ohne Key, mit offenem CORS
// (`Access-Control-Allow-Origin: *`) — der Browser darf die Pixel also direkt
// lesen, wir brauchen keinen Proxy.
//
// KODIERUNG ("terrarium"): Höhe in Metern = (R · 256 + G + B / 256) − 32768.
// Verifiziert gegen bekannte Punkte: Rhein bei Engers 71,1 m (Soll ~72),
// Höhenrücken südöstlich 205,7 m.
//
// Auflösung bei uns (Breite 50°): z14 ≈ 9,5 m/Pixel, z13 ≈ 19 m, z12 ≈ 38 m.
//
// Browserfähig: fetch + createImageBitmap + Canvas. In Node (Agent/Test) gibt
// es kein Canvas — dort müsste ein PNG-Decoder gestellt werden; die Kachel-
// Mathematik unten funktioniert überall.

export const TERRAIN_Z = 14
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const TTL_MS = 60 * 60 * 1000

const tiles = new Map()      // "z/x/y" → { ts, w, h, data: Float32Array } | Promise

// Deckel gegen unbegrenztes Wachstum beim Umherziehen: eine z14-Kachel ist
// 256×256 Float32 = 256 KB und deckt bei uns ~2,4 km. 96 Kacheln sind also
// ~24 MB für gut 550 km² — mehr als jede Sitzung sinnvoll abfährt. Verdrängt
// wird die ÄLTESTE (nach Ladezeitpunkt); wer eine verdrängte Gegend wieder
// betritt, lädt sie neu.
const MAX_TILES = 96

// ─── Kachel-Mathematik (Web-Mercator, gebrochen = inkl. Pixelanteil) ───────
export const lon2tileF = (lon, z) => (lon + 180) / 360 * 2 ** z
export const lat2tileF = (lat, z) => (1 - Math.log(
  Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z

/** Pixelgröße in Metern (für die Wahl der Gitterauflösung). */
export const metersPerPixel = (lat, z = TERRAIN_Z) =>
  156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z / 256 * 256 / 256

async function decodeTile(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const blob = await r.blob()
  // KRITISCH: Farbmanagement AUS. Die Kachel ist keine Grafik, sondern
  // gepackte Zahlen — verschiebt der Browser beim Dekodieren/Zeichnen den
  // Rot-Kanal auch nur um 1, sind das 256 HÖHENMETER (real erlebt: einzelne
  // Nadel-Spitzen im Gelände). premultiplyAlpha ebenso aus.
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const w = bmp.width, h = bmp.height
  // OffscreenCanvas wo verfügbar (auch in Workern), sonst DOM-Canvas.
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
  ctx.drawImage(bmp, 0, 0)
  bmp.close?.()
  const px = ctx.getImageData(0, 0, w, h, { colorSpace: 'srgb' }).data
  const data = new Float32Array(w * h)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (px[p] * 256 + px[p + 1] + px[p + 2] / 256) - 32768
  }
  const fixed = despike(data, w, h)
  if (fixed) console.debug(`[terrain] ${fixed} Ausreißer-Pixel in Kachel geglättet`)
  return { w, h, data }
}

// Nadel-Ausreißer glätten: einzelne Pixel, die sich um mehr als SPIKE_M von
// ihren vier Nachbarn abheben, sind Datenfehler (SRTM-Voids oder ein
// verrutschter Farbkanal), keine Geländekante. Ersetzt durch den Median der
// Nachbarn — echte Steilhänge (Nachbarn ziehen mit) bleiben unangetastet.
const SPIKE_M = 80

/**
 * Nadel-Ausreißer aus einem Höhenraster glätten. Läuft AUCH über die
 * Randpixel (Nachbarzugriff geklemmt) — ein Spike genau auf der Kachelnaht
 * wäre sonst der einzige, der überlebt.
 * @param {Float32Array} data
 * @param {number} w @param {number} h
 * @param {number} [thresh]
 * @returns {number} Anzahl korrigierter Zellen
 */
export function despike(data, w, h, thresh = SPIKE_M) {
  const med4 = (a, b, c, d) => { const s = [a, b, c, d].sort((x, y) => x - y); return (s[1] + s[2]) / 2 }
  const at = (x, y) => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  const fix = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const m = med4(at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1))
      if (Math.abs(data[i] - m) > thresh) fix.push([i, m])
    }
  }
  // Erst sammeln, dann schreiben: sonst dient ein bereits korrigierter Wert
  // als Nachbar für den nächsten und die Glättung frisst sich weiter.
  for (const [i, m] of fix) data[i] = m
  return fix.length
}

function evictOldest() {
  while (tiles.size > MAX_TILES) {
    let oldestKey = null, oldestTs = Infinity
    for (const [k, v] of tiles) {
      if (v instanceof Promise) continue          // läuft noch — nicht anfassen
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
    }
    if (!oldestKey) break
    tiles.delete(oldestKey)
  }
}

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`
  const hit = tiles.get(key)
  if (hit && !(hit instanceof Promise) && Date.now() - hit.ts < TTL_MS) return Promise.resolve(hit)
  if (hit instanceof Promise) return hit
  const p = decodeTile(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y))
    .then(t => { const v = { ...t, ts: Date.now() }; tiles.set(key, v); evictOldest(); return v })
    .catch(err => { tiles.delete(key); throw err })
  tiles.set(key, p)
  return p
}

// Bilineare Abtastung innerhalb einer Kachel (an den Kachelrändern geklemmt —
// der Versatz an Kachelnähten liegt deutlich unter einem Meter).
// `get(tx, ty)` liefert die Kachel oder null; wer keine hat, bekommt null.
function sampleBilinear(get, qLat, qLon, z) {
  const fx = lon2tileF(qLon, z), fy = lat2tileF(qLat, z)
  const tx = Math.floor(fx), ty = Math.floor(fy)
  const t = get(tx, ty)
  if (!t) return null
  const px = (fx - tx) * t.w - 0.5, py = (fy - ty) * t.h - 0.5
  const ix = Math.floor(px), iy = Math.floor(py)
  const rx = px - ix, ry = py - iy
  const at = (cx, cy) => {
    const sx = Math.min(t.w - 1, Math.max(0, cx)), sy = Math.min(t.h - 1, Math.max(0, cy))
    return t.data[sy * t.w + sx]
  }
  return (at(ix, iy) * (1 - rx) + at(ix + 1, iy) * rx) * (1 - ry)
       + (at(ix, iy + 1) * (1 - rx) + at(ix + 1, iy + 1) * rx) * ry
}

/**
 * Höhe aus dem GLOBALEN Kachel-Cache — synchron, ohne zu laden, null wenn die
 * Kachel (noch) nicht da ist.
 *
 * Warum getrennt vom Sampler: Der Sampler kennt nur die Kacheln SEINES
 * Ladelaufs. Wandert das Relief mit der Kamera, liegen Objekte im Rücken
 * außerhalb — sie bekämen `null` und fielen auf die Nullebene. Der Cache
 * dagegen antwortet für jede je geladene Gegend weiter. TTL wird hier bewusst
 * IGNORIERT: eine halbstündig alte Geländehöhe ist unendlich viel besser als
 * ein Loch (Gelände ändert sich nicht).
 */
export function elevationAtCached(lat, lon, z = TERRAIN_Z) {
  return sampleBilinear((tx, ty) => {
    const hit = tiles.get(`${z}/${tx}/${ty}`)
    return hit && !(hit instanceof Promise) ? hit : null
  }, lat, lon, z)
}

/**
 * Höhensampler für ein Areal. Lädt alle nötigen Kacheln EINMAL und liefert
 * dann eine synchrone Abfragefunktion — so kann der Mesh-Bau ohne await
 * durch sein Gitter laufen.
 *
 * @returns {Promise<{ elevationAt(lat:number, lon:number): number, tiles:number }>}
 */
export async function elevationSampler(lat, lon, radiusM, z = TERRAIN_Z) {
  const dLat = radiusM / 111320
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180) || 1)
  const x0 = Math.floor(lon2tileF(lon - dLon, z)), x1 = Math.floor(lon2tileF(lon + dLon, z))
  const y0 = Math.floor(lat2tileF(lat + dLat, z)), y1 = Math.floor(lat2tileF(lat - dLat, z))

  const wanted = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) wanted.push({ x, y })
  const loaded = new Map()
  await Promise.all(wanted.map(async ({ x, y }) => {
    try { loaded.set(`${x}/${y}`, await loadTile(z, x, y)) } catch { /* Lücke → Fallback unten */ }
  }))
  if (!loaded.size) throw new Error('keine Höhenkachel ladbar')

  // Abgefragt wird gegen den globalen Cache, nicht gegen `loaded`: die Kacheln
  // dieses Laufs stecken ohnehin darin, und Punkte außerhalb (Nachbargegend
  // aus einem früheren Lauf) werden so mitbeantwortet statt zu `null`.
  return { elevationAt: (qLat, qLon) => elevationAtCached(qLat, qLon, z), tiles: loaded.size }
}

export function clearTerrainCache() { tiles.clear() }
