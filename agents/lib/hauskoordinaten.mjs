// hauskoordinaten.mjs — amtliche Hausnummern aus dem Liegenschaftskataster.
//
// WOFÜR: OpenStreetMap führt in weiten Teilen keine Hausnummern. An einer
// Teststelle in Neuwied kannte weder Overpass noch Nominatim eine einzige
// Adresse — das Kataster hat dort 16 im 60-Meter-Umkreis, metergenau.
//
// QUELLE: „Hauskoordinaten ohne postalische Anreicherung" des LVermGeo
// Rheinland-Pfalz, Open Data unter dl-de/by-2-0.
//   Bezug:  https://geoshop.rlp.de/opendata-hk.html
//   Ablage: .cache/HAUSKOORDINATEN_RP/ (ignoriert, wie der Registerabzug)
//
// NAMENSNENNUNG IST LIZENZPFLICHT, nicht Kür — siehe `HERKUNFT` unten. Sie
// gehört an jedes Feld aus dieser Quelle.
//
// ZWEI EIGENHEITEN DER DATEN:
//
//   • Die Koordinaten sind UTM (ETRS89, Zone 32), nicht Breite/Länge. Die
//     Umkehrformel steht hier ausgeschrieben — sie ist Standard und spart eine
//     Abhängigkeit (proj4) für vierzig Zeilen Mathematik.
//   • Es gibt KEINE Postleitzahl. „Ohne postalische Anreicherung" meint genau
//     das. Wer eine braucht (die Telefonbuch-Suche braucht sie), holt sie
//     einmal je Gegend über die Geokodierung — sie ist ortsteilweit gleich.
//
// WARUM SQLITE: 1,4 Millionen Zeilen, 196 MB. Ein linearer Durchlauf dauert
// 3,4 Sekunden — für ein Werkzeug, auf das jemand wartet, zu lang. Einmal
// importiert und über gerundete Koordinaten indiziert, antwortet dieselbe
// Abfrage in Millisekunden. `node:sqlite` ist in Node eingebaut — ABER ERST AB
// EINER GEWISSEN VERSION, und `docs/dev-setup.md` verlangt nur „Node 22+“.
//
// Deshalb wird es NACHGELADEN statt oben importiert: Ein fehlendes Modul wäre
// sonst ein Absturz beim Start — unter pm2 eine Neustart-Schleife, und das
// wegen einer Zusatzquelle. Fehlt es, verhält sich das Kataster wie eine
// fehlende Datei: Es gibt keins, der Aufrufer nimmt seine anderen Quellen.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HIER = dirname(fileURLToPath(import.meta.url))
const WURZEL = join(HIER, '..', '..')

/** `node:sqlite`, oder null auf einem Node, das es noch nicht mitbringt. */
async function sqlite() {
  try { return (await import('node:sqlite')).DatabaseSync }
  catch { return null }
}

export const HERKUNFT = 'Liegenschaftskataster (©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0)'

/** Übliche Ablageorte, wenn nichts konfiguriert ist. */
export const ORTE = {
  csv: join(WURZEL, '.cache', 'HAUSKOORDINATEN_RP', 'HAUSKOORDINATEN_RP_hk.csv'),
  db: join(WURZEL, '.cache', 'HAUSKOORDINATEN_RP', 'hauskoordinaten.db'),
}

// Rasterweite des Index: 0,01° sind rund 1,1 km in der Breite. Eine Abfrage
// schaut in die eigene Zelle und ihre Nachbarn — bei Radien bis ein paar
// hundert Meter genügt das mit grossem Abstand.
const RASTER = 100

/**
 * UTM (ETRS89 / WGS84-nah, Zone aus der Datei) → Breite/Länge.
 *
 * Standard-Umkehrformel der transversalen Mercator-Projektion. An einem
 * bekannten Punkt geprüft: Harbach, Hauptstraße 58 → 50.865264, 7.835509.
 */
export function utmZuWgs(ost, nord, zone) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996
  const e2 = f * (2 - f), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const x = ost - 500000, y = nord
  const M = y / k0
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256))
  const p1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
  const ep2 = e2 / (1 - e2)
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2)
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(p1) ** 2, 1.5)
  const D = x / (N1 * k0)
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720)
  const lon = (D
    - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1)
  return { lat: lat * 180 / Math.PI, lon: (zone * 6 - 183) + lon * 180 / Math.PI }
}

/**
 * Eine CSV-Zeile → Adresse, oder null.
 *
 * Spalten (Kopfzeile der Datei):
 *   nba;oid;qua;landschl;land;regbezschl;regbez;kreisschl;kreis;gmdschl;gmd;
 *   ottschl;ott;strschl;str;hnr;adz;zone;ostwert;nordwert
 *
 * `adz` ist der Adresszusatz („a" in „12a"), `ott` der Ortsteil — der ist oft
 * leer und dann sagt `gmd` den Ort.
 */
export function zeileZuAdresse(zeile) {
  const f = String(zeile ?? '').split(';')
  if (f.length < 20) return null
  const zone = Number(f[17]), ost = Number(f[18]), nord = Number(f[19])
  if (!isFinite(zone) || !isFinite(ost) || !isFinite(nord)) return null
  const strasse = (f[14] || '').trim()
  const hausnummer = ((f[15] || '') + (f[16] || '')).trim()
  if (!strasse || !hausnummer) return null
  const { lat, lon } = utmZuWgs(ost, nord, zone)
  if (!isFinite(lat) || !isFinite(lon)) return null
  return { strasse, hausnummer, ort: (f[12] || f[10] || '').trim(), lat, lon }
}

/** Zellenschlüssel für den Index. */
export const zelle = (grad) => Math.round(grad * RASTER)

const R_ERDE = 6371000, RAD = Math.PI / 180
function abstandM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD
  const q = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * R_ERDE * Math.asin(Math.sqrt(q))
}

/**
 * Datenbank öffnen — und beim ersten Mal aus der CSV aufbauen.
 *
 * Der Aufbau dauert ein bis zwei Minuten und passiert genau einmal; danach
 * liegt die Datei neben der CSV. Fehlt die CSV, gibt es kein Kataster und der
 * Aufrufer weicht auf seine anderen Quellen aus — das ist kein Fehler.
 *
 * @returns {Promise<object|null>} geöffnete Datenbank oder null
 */
export async function oeffne({ csv = ORTE.csv, db = ORTE.db, log = () => {} } = {}) {
  if (!existsSync(csv) && !existsSync(db)) return null

  const DatabaseSync = await sqlite()
  if (!DatabaseSync) {
    log(`Kataster übersprungen: dieses Node (${process.version}) bringt `
      + '`node:sqlite` nicht mit. Adressen kommen dann aus OSM und der Geokodierung.')
    return null
  }

  if (!existsSync(db) || (existsSync(csv) && statSync(db).mtimeMs < statSync(csv).mtimeMs)) {
    if (!existsSync(csv)) return null
    log(`Kataster: baue Index aus ${csv} — das dauert einmalig ein bis zwei Minuten`)
    await bauen(DatabaseSync, csv, db, log)
  }

  try {
    const d = new DatabaseSync(db, { readOnly: true })
    const n = d.prepare('SELECT count(*) AS n FROM adressen').get()?.n ?? 0
    log(`Kataster bereit: ${n.toLocaleString('de-DE')} Adressen`)
    return d
  } catch (err) {
    log(`Kataster nicht lesbar: ${err.message}`)
    return null
  }
}

async function bauen(DatabaseSync, csv, dbPfad, log) {
  const d = new DatabaseSync(dbPfad)
  d.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;')
  d.exec('DROP TABLE IF EXISTS adressen')
  d.exec(`CREATE TABLE adressen (
    zlat INTEGER, zlon INTEGER,
    lat REAL, lon REAL,
    strasse TEXT, hausnummer TEXT, ort TEXT
  )`)
  const einfuegen = d.prepare(
    'INSERT INTO adressen (zlat, zlon, lat, lon, strasse, hausnummer, ort) VALUES (?, ?, ?, ?, ?, ?, ?)')

  const rl = createInterface({ input: createReadStream(csv, 'utf8'), crlfDelay: Infinity })
  let kopfWeg = false, n = 0
  d.exec('BEGIN')
  for await (const zeile of rl) {
    if (!kopfWeg) { kopfWeg = true; continue }
    const a = zeileZuAdresse(zeile)
    if (!a) continue
    einfuegen.run(zelle(a.lat), zelle(a.lon), a.lat, a.lon, a.strasse, a.hausnummer, a.ort)
    if (++n % 200000 === 0) { d.exec('COMMIT'); d.exec('BEGIN'); log(`Kataster: ${n.toLocaleString('de-DE')} Adressen …`) }
  }
  d.exec('COMMIT')
  d.exec('CREATE INDEX idx_zelle ON adressen (zlat, zlon)')
  d.close()
  log(`Kataster: ${n.toLocaleString('de-DE')} Adressen aufgenommen`)
}

/**
 * Adressen im Umkreis, nach Entfernung sortiert.
 *
 * Erst die Nachbarzellen greifen (der Index tut die Arbeit), dann exakt
 * nachmessen — ein Rechteck ist kein Kreis.
 */
export function adressenImUmkreis(db, lat, lon, radiusM, max = 8) {
  if (!db) return []
  // Wie viele Zellen deckt der Radius? Eine Zelle ist rund 1,1 km in der
  // Breite und weniger in der Länge — großzügig aufrunden, exakt wird unten
  // gefiltert.
  const spanne = Math.max(1, Math.ceil(radiusM / 700))
  const zl = zelle(lat), zo = zelle(lon)
  const zeilen = db.prepare(
    `SELECT lat, lon, strasse, hausnummer, ort FROM adressen
     WHERE zlat BETWEEN ? AND ? AND zlon BETWEEN ? AND ?`
  ).all(zl - spanne, zl + spanne, zo - spanne, zo + spanne)

  const raus = []
  for (const z of zeilen) {
    const d = abstandM(lat, lon, z.lat, z.lon)
    if (d > radiusM) continue
    raus.push({
      lat: z.lat, lon: z.lon,
      strasse: z.strasse, hausnummer: z.hausnummer, ort: z.ort,
      plz: '',                 // die Datei führt keine — siehe Kopf
      entfernungM: Math.round(d),
      genauigkeit: 'genau',    // amtliche Gebäudekoordinate
      quelle: 'kataster',
      gewerbe: [],
    })
  }
  raus.sort((a, b) => a.entfernungM - b.entfernungM)
  return raus.slice(0, max)
}
