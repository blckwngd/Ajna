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
      // Aus OSM: das IST das Gebaeude, nicht eine Schaetzung daneben. Der
      // Rueckfall ueber Nominatim setzt hier 'ungefaehr' bzw. 'grob' — die
      // Anzeige macht den Unterschied sichtbar.
      genauigkeit: 'genau',
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
 * DIE ERSTE FASSUNG LAS DAS FALSCHE FELD. Sie suchte `nasort="…"` als
 * HTML-Attribut. `nasort` existiert zwar, steht aber in einer versteckten Liste
 * als SORTIERSCHLÜSSEL — großgeschrieben und entpunktet
 * (`nasort:RETHINK E V`), kein Attribut und kein Anzeigename. Der Parser fand
 * damit entweder nichts oder eine verstümmelte Fassung.
 *
 * Der Eintrag selbst steht strukturiert da:
 *
 *     data-entry-data="id=…&at=2&na=ReThink+e.V.&bi=0057&pubNo=307"
 *     <span itemprop="name">ReThink e.V.</span>
 *
 * Gelesen wird `na=` aus `data-entry-data` — eine Zeile je Treffer, URL-kodiert,
 * und damit das, was die Seite selbst als Namen führt. `itemprop="name"` dient
 * als zweiter Weg, falls die Seite das Datenattribut umbaut.
 *
 * Die wichtigste Eigenschaft bleibt: Im Zweifel NICHTS. Ein leeres Ergebnis
 * heißt „nichts gefunden", nie „nichts vorhanden" — den Unterschied macht der
 * Aufrufer.
 */
export function namenAus(html) {
  const s = String(html ?? '')
  const treffer = []

  for (const m of s.matchAll(/data-entry-data="([^"]*)"/g)) {
    const na = /(?:^|&|&amp;)na=([^&"]*)/.exec(m[1])
    if (!na) continue
    let wert = na[1].replace(/\+/g, ' ')
    try { wert = decodeURIComponent(wert) } catch { /* kaputte Kodierung → roh */ }
    const sauber = entschaerfe(wert)
    if (sauber) treffer.push(sauber)
  }

  if (!treffer.length) {
    for (const m of s.matchAll(/itemprop="name"[^>]*>([^<]{2,80})</g)) {
      const sauber = entschaerfe(m[1])
      if (sauber) treffer.push(sauber)
    }
  }

  return [...new Set(treffer)]
}

/**
 * Registertreffer → Felder, jedes mit dem STAND des Abzugs in der Herkunft.
 *
 * Eigene Funktion, weil genau hier die Zusage steckt, die den ganzen Abzug erst
 * vertretbar macht: Der Abzug ist Jahre alt, und eine veraltete Angabe ohne
 * Datum sieht aus wie eine Auskunft über heute. Ohne Stand wird deshalb gar
 * nichts ausgegeben — lieber keine Angabe als eine, die sich als aktuell
 * ausgibt.
 *
 * @param {{firma?, frueher?, register?, anschrift?, gegruendet?, aufgeloest?}|null} zeile
 * @param {string} stand  z. B. "21.10.2022"
 */
export function registerFelder(zeile, stand) {
  if (!zeile || !stand) return []
  const herkunft = `OffeneRegister (Abzug ${stand})`
  const f = []
  const nimm = (feld, wert) => {
    const s = wert == null ? '' : String(wert).trim()
    if (s) f.push({ feld, wert: s, herkunft })
  }
  nimm('Firma', zeile.firma)
  // Die Volltextsuche trifft auch frühere Firmierungen. Wer unter dem alten
  // Namen gesucht hat und den neuen sieht, hält das sonst für einen Fehler.
  nimm('Früher', zeile.frueher)
  nimm('Register', zeile.register)
  nimm('Anschrift', zeile.anschrift)
  nimm('Gegründet', zeile.gegruendet)
  // Eine aufgelöste Firma als bestehende zu zeigen, wäre die Sorte stiller
  // Falschaussage, die dieses Werkzeug vermeiden soll.
  nimm('Aufgelöst', zeile.aufgeloest)
  return f
}

/**
 * Vollständige Telefonbuch-Einträge aus der Trefferliste.
 *
 * Über den Namen hinaus liefert die Seite Rufnummer, Anschrift und einen Link
 * auf die Detailseite. Alles ist schema.org-ausgezeichnet (`itemprop`), also
 * nicht geraten.
 *
 * DIE RUFNUMMER HAT EINE SCRAPER-BREMSE: Sie ist von einem unsichtbaren Element
 * zerschnitten —
 *
 *     02622 90 2<span style='display:none'>&hellip;</span>7 87
 *
 * Wer die Tags naiv entfernt, bekommt `02622 90 2…7 87`, also eine falsche
 * Nummer, die wie eine echte aussieht. Das versteckte Element muss VOR dem
 * Entfernen der Tags weg. (Die Nummer steht jedem Besucher sichtbar auf der
 * Seite; hier wird nur richtig gelesen, was dort steht.)
 */
export function eintraegeAus(html) {
  const s = String(html ?? '')
  const raus = []

  // NICHT `.slice(1)`: Steht der erste Treffer ganz am Anfang, erzeugt `split`
  // mit einem Lookahead KEIN führendes Leerstück — und das Wegschneiden
  // verschluckte den einzigen Eintrag. Auf der echten Seite steht Markup davor,
  // deshalb fiel es dort nicht auf. Also nach Inhalt filtern statt nach Position.
  for (const block of s.split(/(?=<div[^>]*data-entry-data=)/)) {
    const daten = /data-entry-data="([^"]*)"/.exec(block)
    if (!daten) continue
    const feld = (k) => {
      const m = new RegExp(`(?:^|&|&amp;)${k}=([^&"]*)`).exec(daten[1])
      if (!m) return ''
      let v = m[1].replace(/\+/g, ' ')
      try { v = decodeURIComponent(v) } catch { /* roh lassen */ }
      return entschaerfe(v)
    }
    const name = feld('na')
    if (!name) continue

    raus.push({
      name,
      telefon: telefonAus(block),
      strasse: itempropAus(block, 'streetAddress'),
      ort: [itempropAus(block, 'postalCode'), itempropAus(block, 'addressLocality')]
        .filter(Boolean).join(' '),
      link: (/href="(https:\/\/www\.dastelefonbuch\.de\/Details\/[^"]+)"/.exec(block) || [])[1] || '',
    })
  }

  // Doppelte Einträge (dieselbe Person mehrfach ausgezeichnet) zusammenfassen.
  const gesehen = new Set()
  return raus.filter(e => {
    const k = `${e.name}|${e.telefon}`
    if (gesehen.has(k)) return false
    gesehen.add(k)
    return true
  })
}

/** Wert eines schema.org-Feldes, Tags entfernt. */
function itempropAus(html, name) {
  const m = new RegExp(`itemprop="${name}"[^>]*>([\\s\\S]{0,200}?)</span>`).exec(html)
  return m ? entschaerfe(m[1]) : ''
}

/** Rufnummer — erst die unsichtbaren Teile raus, DANN die Tags. */
function telefonAus(html) {
  const m = /itemprop="telephone"[^>]*>([\s\S]{0,400})/.exec(html)
  if (!m) return ''
  const ohneVersteck = m[1]
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
  // Tags ERSATZLOS entfernen, nicht durch ein Leerzeichen. Die Seite zerlegt die
  // Nummer absichtlich mit Markup („90 2<…>7 87"); ein eingefügtes Leerzeichen
  // machte daraus „90 2 7 87" — lesbar, aber falsch.
  const text = entschaerfe(ohneVersteck.replace(/<[^>]*>/g, ''))
  const nummer = /^[\d\s/+()-]{6,30}/.exec(text)
  return nummer ? nummer[0].replace(/\s+/g, ' ').trim() : ''
}

/**
 * Steckt in diesem Ergebnis ein Fehlschlag?
 *
 * WOFÜR: Der Agent hält das letzte Ergebnis je Werkzeug fest, damit
 * wiederholtes Anstupsen nichts kostet. Damit konservierte er aber auch
 * FEHLSCHLÄGE — war eine Quelle einmal kurz gestört, lieferte jede weitere
 * Abfrage denselben Fehler sofort zurück, ohne es noch einmal zu versuchen.
 *
 * Gemeldet als „Telefonbuch: nicht abrufbar (timeout)" an einer Stelle, an der
 * die Seite in 0,27 s antwortete. Ein zwischengespeicherter Fehler sieht aus wie
 * ein dauerhaftes Problem und ist keines.
 */
export function hatAusfall(erg) {
  if (!erg) return false
  if (erg.quelleAus) return true
  return (erg.adressen || []).some(a => (a.felder || []).some(f => f.ausfall))
}

/**
 * Anzeigetext — jedes Feld mit seiner Herkunft, und der Hinweis auf die
 * Flüchtigkeit. Ausfälle werden als Ausfall gekennzeichnet und nicht als
 * „nichts gefunden" verkleidet: Eine Sperre oder ein gebrochener Parser ist
 * keine Aussage über die Adresse.
 */
export function alsText({ adressen = [], radius = 0, quelleAus = false, verborgen = 0 } = {}) {
  // AUSFALL IST KEINE FEHLANZEIGE. „Keine Adresse gefunden" ist eine Aussage
  // über den Ort; wer nicht fragen konnte, darf sie nicht treffen. Der Fall
  // trat wirklich ein: Nach einer Overpass-Drosselung meldete die Lupe an einer
  // Stelle mit Häusern „keine Adresse" — die Sperre erschien als Tatsache.
  if (quelleAus) {
    return 'Die Kartenquelle antwortet gerade nicht — ich kann hier nichts sagen. ' +
           'Bitte gleich noch einmal versuchen.'
  }
  if (!adressen.length) {
    // Weggelassene mitzaehlen: „nichts gefunden" und „geprueft, nichts dabei"
    // sind verschiedene Aussagen.
    return verborgen
      ? `Keine Adresse mit Telefonbucheintrag in der Nähe (${verborgen} geprüft).`
      : `Keine Adresse im Umkreis von ${radius} m gefunden.`
  }
  // KEIN Radius in der Kopfzeile, wohl aber in der Fehlanzeige oben.
  //
  // Grund: Overpass nimmt ein Gebäude, sobald IRGENDEIN Teil seines Umrisses im
  // Radius liegt — die Entfernung daneben misst zum Mittelpunkt. Ein Haus kann
  // also „im Umkreis von 25 m" liegen und trotzdem mit 69 m dastehen. Beides
  // stimmt, zusammen liest es sich wie ein Fehler. Die Entfernung je Eintrag
  // ist die nützlichere Angabe; der Suchradius gehört nur dorthin, wo er etwas
  // erklärt — nämlich wenn gar nichts gefunden wurde.
  const zeilen = [`${adressen.length} Adresse(n) in der Nähe:`]
  for (const a of adressen) {
    zeilen.push('')
    // Eine ungefaehre Lage MUSS als solche dastehen. Eine Schaetzung, die wie
    // eine Hausnummer aussieht, ist die Sorte stiller Falschaussage, die dieses
    // Werkzeug ueberall sonst vermeidet.
    const wie = a.genauigkeit === 'grob' ? '  (ungefähre Lage)'
              : a.genauigkeit === 'ungefaehr' ? '  (Lage geschätzt)' : ''
    zeilen.push(`📍 ${a.strasse} ${a.hausnummer}${a.plz ? `, ${a.plz} ${a.ort}` : ''} (${a.entfernungM} m)${wie}`)
    const felder = a.felder || a.gewerbe || []
    if (!felder.length) { zeilen.push('   — keine weiteren öffentlichen Angaben'); continue }
    for (const f of felder) {
      zeilen.push(`   ${f.ausfall ? '⚠' : '·'} ${f.feld}: ${f.wert}   [${f.herkunft}]`)
    }
  }
  zeilen.push('')
  if (verborgen) zeilen.push(`(${verborgen} weitere Adresse(n) ohne Telefonbucheintrag ausgelassen)`)
  // NAMENSNENNUNG IST LIZENZPFLICHT (dl-de/by-2-0), nicht Höflichkeit — sie
  // erscheint, sobald eine Adresse aus dem Kataster stammt.
  if (adressen.some(a => a.quelle === 'kataster')) {
    zeilen.push('Adressen: ©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0')
  }
  zeilen.push('Diese Anzeige ist flüchtig — sie wird nirgends gespeichert.')
  return zeilen.join('\n')
}

// ─── Suchumkreis ──────────────────────────────────────────────────────────
//
// Der Umkreis steht in `agents/.env.address-bridge` (ADR_RADIUS_M) und kann
// zusaetzlich aus `agent_settings` kommen. Beides ist Eingabe von aussen und
// gehoert begrenzt — nicht aus Bevormundung, sondern weil JEDE gefundene
// Adresse einzeln durch Impressum, Register und Telefonbuch laeuft. 500 Meter
// ergeben leicht hundert Adressen, also hundert Fremdabfragen aus einem
// Tastendruck. Das sperrt die Quellen aus, und zwar zu Recht.

export const RADIUS_MIN = 5
export const RADIUS_MAX = 250
export const RADIUS_VORGABE = 25

/** Eingabe auf das Machbare bringen — lieber begrenzt als ausgesperrt. */
export function radiusPruefen(wert) {
  const n = Number(String(wert ?? '').replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return RADIUS_VORGABE
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n)))
}
