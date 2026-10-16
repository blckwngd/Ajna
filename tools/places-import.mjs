#!/usr/bin/env node
// places-import.mjs — einen Ortsabzug in die SQLite-Form bringen.
//
// WARUM NICHT DIREKT PARQUET. Overture liefert Parquet, und ein Parquet-Leser
// wäre eine neue Laufzeit-Abhängigkeit für etwas, das genau EINMAL je Abzug
// läuft. Stattdessen liest dieses Werkzeug zeilenweises JSON — das erzeugt
// DuckDB aus dem Parquet in einer Zeile, und danach braucht Ajna nichts
// Fremdes mehr. Dasselbe Verhältnis wie beim Kataster: einmal umwandeln, dann
// offline und in Millisekunden lesen.
//
// DEN AUSZUG HOLEN (DuckDB, einmalig; Beispiel Rheinland-Pfalz):
//
//   INSTALL spatial; LOAD spatial;
//   COPY (
//     SELECT id, names.primary AS name, categories.primary AS kategorie,
//            ST_Y(geometry) AS lat, ST_X(geometry) AS lon,
//            websites[1] AS webseite, phones[1] AS telefon, emails[1] AS email,
//            addresses[1].freeform AS strasse, addresses[1].postcode AS plz,
//            addresses[1].locality AS ort, confidence AS guete
//     FROM read_parquet('s3://overturemaps-us-west-2/release/<RELEASE>/theme=places/type=place/*')
//     WHERE bbox.xmin BETWEEN 6.1 AND 8.6 AND bbox.ymin BETWEEN 48.9 AND 51.0
//   ) TO 'orte.json' (FORMAT JSON);
//
//   node tools/places-import.mjs orte.json --quelle=overture-2026-09
//
// Die Datei landet unter `.cache/orte.db` und wird von `agents/lib/places.mjs`
// gelesen. Fehlt sie, ist das kein Fehler — dann bleibt es bei OSM.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, INDEX, zelle } from '../agents/lib/places.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function argumente() {
  return {
    EIN: process.argv.slice(2).find(a => !a.startsWith('-')),
    AUS: path.resolve(arg('out', path.join(ROOT, '.cache', 'orte.db'))),
    QUELLE: arg('quelle', 'overture'),
    MIN_GUETE: Number(arg('min-guete', 0)),
  }
}

function hilfe() {
  console.error('Args: places-import.mjs <datei.json> [--quelle=overture-2026-09]')
  console.error('                        [--out=.cache/orte.db] [--min-guete=0.5]')
  console.error('\nEingabe: eine JSON-Zeile je Ort, oder ein JSON-Array, oder GeoJSON.')
  process.exit(2)
}

/**
 * Einen Datensatz auf das Schema abbilden.
 *
 * GROSSZÜGIG BEIM LESEN: Overture benennt Felder zwischen Veröffentlichungen
 * um (`categories.primary` wurde zu `basic_category`), und wer den Auszug mit
 * eigenem SQL zieht, nennt sie ohnehin anders. Lieber mehrere Schreibweisen
 * annehmen als bei jeder Fassung dieses Werkzeug anfassen.
 */
export function zuOrt(roh, quelle) {
  const g = roh?.geometry
  const koord = Array.isArray(g?.coordinates) ? g.coordinates : null
  const lat = Number(roh?.lat ?? roh?.latitude ?? koord?.[1])
  const lon = Number(roh?.lon ?? roh?.lng ?? roh?.longitude ?? koord?.[0])
  const p = roh?.properties || roh
  const erst = (v) => (Array.isArray(v) ? v[0] : v) || null
  const name = p?.name || p?.names?.primary || erst(p?.names?.common) || null
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null

  const adr = erst(p?.addresses) || {}
  return {
    id: String(p?.id || roh?.id || `${quelle}:${lat.toFixed(6)},${lon.toFixed(6)}:${name}`),
    quelle,
    name: String(name).trim(),
    kategorie: p?.kategorie || p?.basic_category || p?.categories?.primary || p?.category || null,
    lat, lon,
    webseite: erst(p?.webseite ?? p?.websites ?? p?.website),
    telefon: erst(p?.telefon ?? p?.phones ?? p?.phone),
    email: erst(p?.email ?? p?.emails),
    strasse: p?.strasse || adr?.freeform || null,
    hausnummer: p?.hausnummer || null,
    plz: p?.plz || adr?.postcode || null,
    ort: p?.ort || adr?.locality || null,
    guete: Number.isFinite(Number(p?.guete ?? p?.confidence)) ? Number(p?.guete ?? p?.confidence) : null,
  }
}

/** Eine Zeile der Eingabe → Datensatz. Array- und GeoJSON-Hüllen abstreifen. */
export function zeileLesen(zeile) {
  const t = zeile.trim().replace(/,$/, '')
  if (!t || t === '[' || t === ']' || t === '{"type":"FeatureCollection","features":[') return null
  try { return JSON.parse(t) } catch { return null }
}

/**
 * Der Lauf — in einer Funktion, NICHT auf Modulebene.
 *
 * Sonst schriebe ein blosses `import` dieser Datei eine Datenbank, und die
 * Abbildung oben wäre nicht prüfbar, ohne den ganzen Durchgang anzustossen.
 * Derselbe Riegel wie in `tools/world-cleanup.mjs`.
 */
async function main() {
  const { EIN, AUS, QUELLE, MIN_GUETE } = argumente()
  if (!EIN) hilfe()
  if (!fs.existsSync(EIN)) { console.error(`Keine Datei unter ${EIN}`); process.exit(2) }

  fs.mkdirSync(path.dirname(AUS), { recursive: true })
  if (fs.existsSync(AUS)) fs.rmSync(AUS)
  const db = new DatabaseSync(AUS)
  db.exec('PRAGMA journal_mode = OFF')
  db.exec(SCHEMA)
  const ein = db.prepare(
    `INSERT OR REPLACE INTO orte
     (id, quelle, name, kategorie, lat, lon, zlat, zlon, webseite, telefon, email,
      strasse, hausnummer, plz, ort, guete)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

  let gelesen = 0, genommen = 0, verworfen = 0
  const rl = readline.createInterface({ input: fs.createReadStream(EIN), crlfDelay: Infinity })
  db.exec('BEGIN')
  for await (const zeile of rl) {
    const roh = zeileLesen(zeile)
    if (!roh) continue
    gelesen++
    const o = zuOrt(roh, QUELLE)
    if (!o) { verworfen++; continue }
    if (MIN_GUETE > 0 && Number(o.guete ?? 1) < MIN_GUETE) { verworfen++; continue }
    ein.run(o.id, o.quelle, o.name, o.kategorie, o.lat, o.lon, zelle(o.lat), zelle(o.lon),
            o.webseite, o.telefon, o.email, o.strasse, o.hausnummer, o.plz, o.ort, o.guete)
    if (++genommen % 100000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); console.error(`  … ${genommen.toLocaleString('de-DE')}`) }
  }
  db.exec('COMMIT')
  db.exec(INDEX)
  const mitWeb = db.prepare('SELECT count(*) AS n FROM orte WHERE webseite IS NOT NULL').get()?.n ?? 0
  db.close()

  console.error(`\n${genommen.toLocaleString('de-DE')} Orte aufgenommen (${verworfen} verworfen von ${gelesen} gelesen)`)
  console.error(`davon mit Webseite: ${mitWeb.toLocaleString('de-DE')} — nur die taugen für die Netzspur`)
  console.error(`→ ${AUS}`)
}

const direkt = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (direkt) await main()
