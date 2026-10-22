// ort.mjs — Stadt, Landkreis, Bundesland, Staat als sprechfertige Werte.
//
// QUELLE: die öffentliche Nominatim-API (nominatim.openstreetmap.org),
// Rückwärts-Geokodierung. Kein eigener Server — die Nutzungsbedingungen
// verlangen dafür drei Dinge, und alle drei stehen hier: höchstens EINE
// Anfrage je Sekunde, ein ehrlicher User-Agent mit Kontakt, und Ergebnisse
// aufheben statt neu fragen. (https://operations.osmfoundation.org/policies/nominatim/)
//
// AMTLICHE GRENZEN STATT RASTER — ohne eigene Grenzdaten. Der Entwurf in
// docs/welt-kontext.md warnt: Eine Rasterzelle liegt irgendwann auf einer
// Landesgrenze, und dann sagt die Figur das falsche Bundesland. Nominatim
// liefert mit `polygon_geojson=1` die Umrisslinie der getroffenen Gemeinde
// mit (Koblenz: 97 Punkte, 2,4 KB bei `polygon_threshold=0.001`). Die wird
// aufgehoben; jeder weitere Punkt wird zuerst gegen die bekannten Umrisse
// geprüft — Punkt im Polygon, reine Arithmetik, kein Netz. Nominatim wird
// nur für Punkte gefragt, die in KEINER bekannten Gemeinde liegen. Eine
// Gegend kostet so eine Anfrage, nicht eine je Zelle und nicht eine je
// Gespräch.
//
// Ohne Umriss (manche Treffer haben keinen) gilt der Treffer für Punkte in
// NAEHE_OHNE_UMRISS_M um den Abfragepunkt — ehrlich klein, damit an einer
// Grenze nichts Falsches gesagt wird.
//
// SPRECHFERTIG, NICHT ROH: `ort.stadt` ist „Koblenz", `ort.text` ist
// „Koblenz, Rheinland-Pfalz". Parley setzt ein, es rechnet nicht.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Quellcache, cacheWurzel } from './quellcache.mjs'

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org'
/** Ein Treffer ohne Umriss gilt nur dicht um den Abfragepunkt. */
export const NAEHE_OHNE_UMRISS_M = 1500
/** Gemeindegrenzen ändern sich selten; ein Vierteljahr ist vorsichtig. */
export const ORT_TTL_MS = 90 * 24 * 3600_000
/** Mehr Gemeinden hält niemand im Kopf — und niemand in einem Prozess. */
const MAX_ORTE = 400

/**
 * Antwort von Nominatim (`format=jsonv2`, `addressdetails=1`) in `ort.*`
 * übersetzen. Eigene Funktion, damit sie ohne Netz geprüft werden kann.
 */
export function ortVars(antwort) {
  const a = antwort?.address || {}
  const erstes = (...k) => { for (const x of k) { const v = a[x]; if (typeof v === 'string' && v.trim()) return v.trim() } return null }
  const stadt = erstes('city', 'town', 'village', 'municipality', 'hamlet', 'borough')
    || (typeof antwort?.name === 'string' && antwort.name.trim() ? antwort.name.trim() : null)
  const ortsteil = erstes('suburb', 'city_district', 'quarter', 'neighbourhood')
  const kreis = erstes('county', 'state_district')
  const land = erstes('state')
  const staat = erstes('country')
  const staat_code = typeof a.country_code === 'string' ? a.country_code.toLowerCase() : null
  const text = [stadt, land].filter(Boolean).join(', ') || staat || ''
  return { stadt, ortsteil, kreis, land, staat, staat_code, text }
}

// ── Punkt im Polygon ─────────────────────────────────────────────────────
// GeoJSON: Polygon = [ring, loch, loch…], MultiPolygon = [Polygon…]; ein
// Ring ist [[lon, lat], …]. Strahlmethode; ein Punkt in einem Loch liegt
// nicht im Polygon.

function imRing(ring, lon, lat) {
  let drin = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) drin = !drin
  }
  return drin
}

function imPolygon(ringe, lon, lat) {
  if (!Array.isArray(ringe) || !ringe.length || !imRing(ringe[0], lon, lat)) return false
  for (let i = 1; i < ringe.length; i++) if (imRing(ringe[i], lon, lat)) return false
  return true
}

/** Liegt (lat, lon) in der GeoJSON-Geometrie? Nur Polygon und MultiPolygon zählen. */
export function punktInGeometrie(geojson, lat, lon) {
  if (!geojson || typeof geojson !== 'object') return false
  if (geojson.type === 'Polygon') return imPolygon(geojson.coordinates, lon, lat)
  if (geojson.type === 'MultiPolygon') return (geojson.coordinates || []).some(p => imPolygon(p, lon, lat))
  return false
}

/** Haversine, Meter — lokale Kopie, damit das Modul nur quellcache kennt. */
function abstandM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Der Anbieter für `Weltkontext` — PUNKTGENAU, nicht je Zelle: Er kennt
 * Gemeinden, nicht Rasterzellen (`punktgenau: true`, siehe weltkontext.mjs).
 *
 * @param {object} [opts]
 * @param {string} [opts.basis]      Nominatim-Adresse (Vorgabe: die öffentliche)
 * @param {string} [opts.kontakt]    E-Mail oder Seite für den User-Agent — die
 *                                   Nutzungsbedingungen verlangen eine Kontaktangabe
 * @param {number} [opts.ttlMs]      wie lange ein Treffer gilt
 * @param {number} [opts.proTag]     Obergrenze echter Anfragen je Tag
 * @param {Function} [opts.abruf]    nur für Tests: ersetzt `fetch`
 * @param {string|null} [opts.dir]   Ablageort (Tests); `false` = nichts auf Platte
 * @param {Function} [opts.warn]
 */
export function ortAnbieter({
  basis = NOMINATIM_URL, kontakt = '', ttlMs = ORT_TTL_MS, proTag = 400,
  abruf = fetch, dir = null, warn = console.warn, timeoutMs = 15_000, jetzt = Date.now,
} = {}) {
  const ablage = dir === false ? null : (dir || cacheWurzel('weltkontext-ort'))
  // Budget und Mindestabstand teilt der Quellcache über `_budget.json` mit
  // jedem anderen Prozess, der dieselbe Quelle benutzt — Director und Persona
  // fragen Nominatim zusammen höchstens einmal je Sekunde. `dir: false`
  // (Tests) bekommt ein eigenes Budget im Temp-Verzeichnis: Ein Test darf
  // weder das echte Tagesbudget verbrauchen noch am Abstand des vorigen
  // Tests scheitern.
  const budgetDir = ablage || join(tmpdir(), `ajna-ort-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const budget = new Quellcache('weltkontext-ort', { minAbstandMs: 1100, proTag, dir: budgetDir, log: () => {} })
  const datei = ablage ? join(ablage, 'orte.json') : null
  const ua = `Ajna/1.0 (+https://github.com/blckwngd/Ajna${kontakt ? `; ${kontakt}` : ''})`

  /** @type {Array<{schluessel:string, werte:object, umriss:object|null, punkt:{lat:number,lon:number}, ts:number}>} */
  let orte = []
  let geladen = null

  const laden = () => {
    if (geladen) return geladen
    geladen = (async () => {
      if (!datei) return
      try {
        const roh = JSON.parse(await readFile(datei, 'utf8'))
        if (Array.isArray(roh)) orte = roh.filter(o => o && o.werte && o.punkt)
      } catch { /* noch nichts aufgehoben */ }
    })()
    return geladen
  }
  const speichern = async () => {
    if (!datei) return
    try {
      await mkdir(ablage, { recursive: true })
      await writeFile(datei, JSON.stringify(orte), 'utf8')
    } catch (err) { warn(`[ort] Ablage: ${err?.message || err}`) }
  }

  const gueltig = (o) => jetzt() - (o.ts || 0) < ttlMs
  const trifft = (o, lat, lon) => {
    if (!gueltig(o)) return false
    if (o.umriss) return punktInGeometrie(o.umriss, lat, lon)
    return abstandM(o.punkt.lat, o.punkt.lon, lat, lon) <= NAEHE_OHNE_UMRISS_M
  }
  const finde = (lat, lon) => orte.find(o => trifft(o, lat, lon)) || null

  return {
    name: 'ort',
    punktgenau: true,
    ttlMs,

    /** Bekannt, ohne Netz? */
    kennt(lat, lon) { return !!finde(lat, lon) },

    /** Die Werte für einen Punkt — SYNCHRON, aus dem Bekannten. */
    lies(lat, lon) {
      const o = finde(lat, lon)
      return o ? { ...o.werte } : null
    },

    /**
     * Einen Punkt bekannt machen: nichts tun, wenn er in einer bekannten
     * Gemeinde liegt; sonst EINE Anfrage — sofern Budget und Abstand es
     * erlauben. Liefert true, wenn etwas geholt wurde.
     */
    async vorbereiten({ lat, lon }) {
      await laden()
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
      if (finde(lat, lon)) return false
      const darf = await budget.darfAbfragen()
      if (!darf.ok) {
        if (darf.grund !== 'zu-frueh') warn(`[ort] keine Anfrage (${darf.grund})`)
        return false
      }
      const url = `${basis.replace(/\/+$/, '')}/reverse?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`
        + '&zoom=10&addressdetails=1&polygon_geojson=1&polygon_threshold=0.001&accept-language=de'
      await budget.buche(1)   // die ANFRAGE zählt, nicht die gelungene Antwort
      const r = await abruf(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': ua, 'Accept': 'application/json' } })
      if (!r.ok) throw new Error(`Nominatim antwortet ${r.status}`)
      const antwort = await r.json()
      if (antwort?.error) throw new Error(`Nominatim: ${antwort.error}`)
      const werte = ortVars(antwort)
      if (!werte.stadt && !werte.land && !werte.staat) return false
      const g = antwort.geojson
      const umriss = g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null
      const schluessel = antwort.osm_type && antwort.osm_id ? `${antwort.osm_type}:${antwort.osm_id}` : `p:${lat.toFixed(3)},${lon.toFixed(3)}`
      orte = orte.filter(o => o.schluessel !== schluessel && gueltig(o))
      orte.unshift({ schluessel, werte, umriss, punkt: { lat, lon }, ts: jetzt() })
      if (orte.length > MAX_ORTE) orte.length = MAX_ORTE
      await speichern()
      return true
    },

    /** Für Tests und Logs: wie viele Gemeinden sind bekannt? */
    get bestand() { return orte.filter(gueltig).length },
  }
}
