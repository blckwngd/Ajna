// adresse.mjs — die prüfbaren Teile der Adress-Anreicherung.
//
// WARUM EIGENES MODUL: `agents/address-bridge.mjs` ist ein Startskript — es
// meldet sich an und beginnt zu horchen, sobald man es importiert. Genau die
// Stellen, an denen dort etwas still brechen kann, lassen sich darin nicht
// prüfen:
//
//   • Die Auswertung der Overpass-Antwort (Felder fehlen, `way` statt `node`,
//     Entfernungen, Reihenfolge).
//   • Der Aufbau der Telefonbuch-URL (Trennzeichen sind nirgends dokumentiert
//     und aus einem einzigen Beispiel abgelesen).
//   • Die Textaufbereitung — sie trägt die Herkunftsangabe je Feld, und genau
//     die ist der Sinn der Vorführung.
//
// Deshalb liegen sie hier, ohne Netz und ohne Anmeldung.

/** Entfernung zweier Punkte in Metern (Haversine). */
export function abstandM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Gewerbliche Merkmale aus OSM-Tags — jedes mit seiner Herkunft.
 *
 * Die Herkunft ist kein Schmuck: Sie ist der Unterschied zwischen einem
 * Auskunftswerkzeug und einer Vorführung. Der Betrachter soll sehen, DASS jedes
 * Stück offen herumlag, nicht nur, was zusammenkommt.
 */
export function gewerbeAus(t = {}) {
  const f = []
  const nimm = (feld, wert) => { if (wert) f.push({ feld, wert: String(wert), herkunft: 'OpenStreetMap' }) }
  nimm('Name', t.name)
  nimm('Betreiber', t.operator)
  nimm('Telefon', t.phone || t['contact:phone'])
  nimm('Webseite', t.website || t['contact:website'])
  nimm('E-Mail', t.email || t['contact:email'])
  nimm('Öffnungszeiten', t.opening_hours)
  return f
}

/**
 * Overpass-Antwort → Adressliste, nach Entfernung sortiert.
 *
 * `way`-Elemente tragen ihren Punkt in `center` (weil `out center` das so
 * liefert), `node`-Elemente direkt. Wer nur `el.lat` liest, verliert stillschweigend
 * jedes Gebäude — und Häuser sind in OSM meistens Flächen, nicht Punkte.
 */
export function adressenAus(antwort, lat, lon, max = 8) {
  const raus = []
  for (const el of antwort?.elements || []) {
    const t = el.tags || {}
    if (!t['addr:housenumber']) continue
    const p = el.center || el
    if (!isFinite(p?.lat) || !isFinite(p?.lon)) continue
    raus.push({
      lat: p.lat, lon: p.lon,
      strasse: t['addr:street'] || '',
      hausnummer: String(t['addr:housenumber']),
      plz: t['addr:postcode'] || '',
      ort: t['addr:city'] || '',
      entfernungM: Math.round(abstandM(lat, lon, p.lat, p.lon)),
      gewerbe: gewerbeAus(t),
    })
  }
  raus.sort((a, b) => a.entfernungM - b.entfernungM)
  return raus.slice(0, max)
}

/**
 * URL der Rückwärtssuche.
 *
 * Schema an einem echten Aufruf bestätigt, aber nirgends dokumentiert:
 * `/Rückwärts-Suche/<PLZ>----<Straße>--<Hausnummer>`, Umlaute prozent-kodiert.
 * Bricht die Suche, ist das die erste Stelle zum Nachsehen.
 */
export function telefonbuchUrl(plz, strasse, hausnummer) {
  const teil = (s) => encodeURIComponent(String(s ?? '').trim())
  return 'https://www.dastelefonbuch.de/R%C3%BCckw%C3%A4rts-Suche/' +
         `${teil(plz)}----${teil(strasse)}--${teil(hausnummer)}`
}

/** HTML-Entities und Restmarkup aus einem Attributwert holen. */
export function entschaerfe(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Namen aus der Trefferliste ziehen.
 *
 * Es gibt kein JSON-LD und kein schema.org — geparst wird gegen ein
 * Markup-Attribut. Das bricht bei jedem Redesign der Seite, und deshalb ist die
 * wichtigste Eigenschaft dieser Funktion: Sie liefert im Zweifel NICHTS. Ein
 * leeres Ergebnis heißt „nichts gefunden", nie „nichts vorhanden" — den
 * Unterschied macht der Aufrufer.
 */
export function namenAus(html) {
  const treffer = [...String(html ?? '').matchAll(/nasort="([^"]{2,80})"/g)]
    .map(m => entschaerfe(m[1]))
    .filter(Boolean)
  return [...new Set(treffer)]
}

/**
 * Anzeigetext — jedes Feld mit seiner Herkunft, und der Hinweis auf die
 * Flüchtigkeit. Ausfälle werden als Ausfall gekennzeichnet und nicht als
 * „nichts gefunden" verkleidet: Eine Sperre oder ein gebrochener Parser ist
 * keine Aussage über die Adresse.
 */
export function alsText({ adressen = [], radius = 0 } = {}) {
  if (!adressen.length) return `Keine Adresse im Umkreis von ${radius} m gefunden.`
  const zeilen = [`${adressen.length} Adresse(n) im Umkreis von ${radius} m:`]
  for (const a of adressen) {
    zeilen.push('')
    zeilen.push(`📍 ${a.strasse} ${a.hausnummer}${a.plz ? `, ${a.plz} ${a.ort}` : ''} (${a.entfernungM} m)`)
    const felder = a.felder || a.gewerbe || []
    if (!felder.length) { zeilen.push('   — keine weiteren öffentlichen Angaben'); continue }
    for (const f of felder) {
      zeilen.push(`   ${f.ausfall ? '⚠' : '·'} ${f.feld}: ${f.wert}   [${f.herkunft}]`)
    }
  }
  zeilen.push('')
  zeilen.push('Diese Anzeige ist flüchtig — sie wird nirgends gespeichert.')
  return zeilen.join('\n')
}
