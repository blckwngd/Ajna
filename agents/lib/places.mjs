// places.mjs — Betriebe und Orte aus einem lokalen Abzug.
//
// WOZU. OpenStreetMap ist in Städten dicht und auf dem Land löchrig. Wer dort
// eine Adress-Lupe oder einen POI-Agenten betreibt, bekommt leere Listen —
// nicht weil nichts da wäre, sondern weil es niemand eingetragen hat.
//
// BEWUSST QUELLENUNABHÄNGIG. Die Datei heisst `places`, nicht `overture`: Das
// Schema unten nimmt jeden Abzug auf, der Name, Ort und ein paar Felder führt.
// Overture Maps ist der erste (81 Mio. Orte, CDLA-Permissive 2.0, keine
// Share-alike-Pflicht, monatlich als Parquet), aber ein zweiter soll nicht
// bedeuten, dass hier alles umgeschrieben wird. `quelle` steht an jeder Zeile,
// damit sich Abzüge mischen lassen, ohne sich zu verwechseln.
//
// DASSELBE MUSTER WIE KATASTER UND HANDELSREGISTER: eine SQLite-Datei unter
// `.cache/`, einmal geöffnet, und ein fehlender Abzug ist KEIN Fehler — er ist
// eine Quelle, die gerade nichts sagt. Der Aufrufer merkt das an einer leeren
// Liste und weicht auf OSM aus.
//
// Die Umwandlung macht `tools/places-import.mjs`; der Weg vom Overture-Parquet
// dorthin steht in `docs/adress-anreicherung-quellen.md`.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

/** Rasterweite des Suchindex in Grad — rund 1,1 km in der Breite. */
const ZELLE = 0.01
export const cell = (grad) => Math.round(grad / ZELLE)

/** Äquirektangulare Näherung; auf diesen Entfernungen genau genug. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180
  const dLat = (lat2 - lat1) * r
  const dLon = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r)
  return Math.sqrt(dLat * dLat + dLon * dLon) * 6371000
}

/** Das Schema. Eine Zeile je Ort, flach — es soll leicht zu befüllen sein. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS orte (
  id        TEXT PRIMARY KEY,
  quelle    TEXT NOT NULL,
  name      TEXT NOT NULL,
  kategorie TEXT,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  zlat      INTEGER NOT NULL,
  zlon      INTEGER NOT NULL,
  webseite  TEXT,
  telefon   TEXT,
  email     TEXT,
  strasse   TEXT,
  hausnummer TEXT,
  plz       TEXT,
  ort       TEXT,
  guete     REAL
);`

export const INDEX = 'CREATE INDEX IF NOT EXISTS idx_orte_zelle ON orte (zlat, zlon)'

/**
 * Einen Abzug öffnen — oder ehrlich sagen, dass keiner da ist.
 *
 * @returns {{db: object|null, pfad: string|null, grund: string}}
 */
export function openPlaces(kandidaten) {
  const liste = (Array.isArray(kandidaten) ? kandidaten : [kandidaten]).filter(Boolean)
  const pfad = liste.find(p => existsSync(p))
  if (!pfad) return { db: null, pfad: null, grund: `kein Abzug gefunden (gesucht: ${liste.join(', ')})` }
  try {
    const db = new DatabaseSync(pfad, { readOnly: true })
    // EINMAL NACHSEHEN, OB ES DIE TABELLE GIBT. Eine SQLite-Datei mit dem
    // richtigen Namen und falschem Inhalt wäre sonst erst bei der ersten
    // Abfrage aufgefallen — mitten im Spiel, als Ausnahme.
    const n = db.prepare('SELECT count(*) AS n FROM orte').get()?.n ?? 0
    return { db, pfad, grund: '', anzahl: n }
  } catch (err) {
    return { db: null, pfad, grund: err?.message || String(err) }
  }
}

/**
 * Orte im Umkreis, nach Entfernung sortiert.
 *
 * Erst über den Zellenindex grob greifen, dann exakt nachmessen — ein Rechteck
 * ist kein Kreis. Dieselbe Mechanik wie beim Kataster.
 *
 * @param {object} db
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusM
 * @param {object} [opts]
 * @param {number}   [opts.max=50]
 * @param {number}   [opts.minGuete=0]   Overture führt je Ort einen Wert 0…1
 * @param {string[]} [opts.kategorien]   nur diese (Präfix-Vergleich)
 * @param {boolean}  [opts.nurMitWebseite=false]
 */
export function placesNearby(db, lat, lon, radiusM, opts = {}) {
  if (!db || !Number.isFinite(lat) || !Number.isFinite(lon)) return []
  const { max = 50, minGuete = 0, kategorien = null, nurMitWebseite = false } = opts
  const spanne = Math.max(1, Math.ceil(radiusM / 700))
  const zl = cell(lat), zo = cell(lon)

  let zeilen
  try {
    zeilen = db.prepare(
      `SELECT id, quelle, name, kategorie, lat, lon, webseite, telefon, email,
              strasse, hausnummer, plz, ort, guete
       FROM orte WHERE zlat BETWEEN ? AND ? AND zlon BETWEEN ? AND ?`
    ).all(zl - spanne, zl + spanne, zo - spanne, zo + spanne)
  } catch { return [] }

  const raus = []
  for (const z of zeilen) {
    if (nurMitWebseite && !z.webseite) continue
    if (minGuete > 0 && Number(z.guete ?? 1) < minGuete) continue
    if (kategorien?.length && !kategorien.some(k => String(z.kategorie || '').startsWith(k))) continue
    const d = distanceM(lat, lon, z.lat, z.lon)
    if (d > radiusM) continue
    raus.push({ ...z, distanceM: Math.round(d) })
  }
  raus.sort((a, b) => a.distanceM - b.distanceM)
  return raus.slice(0, max)
}

/**
 * Einen Ort in die Feldform der Adress-Lupe bringen.
 *
 * JEDES FELD TRÄGT SEINE HERKUNFT — dritte Regel der Lupe. Die Quelle steht
 * an der Zeile, nicht in einer Fussnote: Wer „Overture" liest, weiss, dass
 * dieser Eintrag nicht von einem Ortskundigen stammt.
 */
export function asFields(ort, quellName = null) {
  if (!ort?.name) return []
  const q = quellName || `Ortsabzug (${ort.quelle || 'unbekannt'})`
  const f = [{ feld: 'Name', wert: ort.name, herkunft: q }]
  const nimm = (feld, wert) => { if (wert) f.push({ feld, wert: String(wert), herkunft: q }) }
  nimm('Branche', ort.kategorie)
  nimm('Webseite', ort.webseite)
  nimm('Telefon', ort.telefon)
  nimm('E-Mail', ort.email)
  return f
}

/**
 * Zwei Listen zusammenführen — OSM gewinnt bei gleichem Namen.
 *
 * WARUM OSM VORGEHT: Dort trägt jemand ein, der da war. Ein Abzug ist breiter,
 * aber anonym zusammengetragen; wo beide etwas sagen, ist die ortskundige
 * Angabe die bessere. Der Abzug FÜLLT LÜCKEN, er überschreibt nichts.
 */
export function mergeByName(osm, abzug, { schluessel = (x) => normaliseName(x.name) } = {}) {
  const bekannt = new Set((osm || []).map(schluessel).filter(Boolean))
  const dazu = (abzug || []).filter(x => {
    const k = schluessel(x)
    return k && !bekannt.has(k)
  })
  return { liste: [...(osm || []), ...dazu], ergaenzt: dazu.length }
}

/**
 * Namen vergleichbar machen: Kleinschreibung, keine Rechtsform, kein Beiwerk.
 *
 * „und" FÄLLT MIT WEG, und das ist kein Detail: OSM führt „Weber & Sohn", der
 * Abzug „Weber und Sohn" — derselbe Betrieb, zweimal in der Liste, wenn man
 * nur Sonderzeichen entfernt. Beim Zusammenführen ist eine Dublette schlimmer
 * als eine etwas zu grosszügige Ähnlichkeit: Sie steht sichtbar nebeneinander.
 */
export function normaliseName(name) {
  return String(name || '').toLowerCase()
    .replace(/\b(gmbh|mbh|ag|kg|ohg|gbr|ug|e\.?\s?k\.?|e\.?\s?v\.?|co\.?|und)\b/g, ' ')
    .replace(/[^a-zäöüß0-9]+/g, '')
    .trim()
}
