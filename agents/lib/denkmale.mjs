// denkmale.mjs — Denkmale aus den Wikipedia-Gemeindelisten lesen.
//
// Natur- und Kulturdenkmale (gleiche Vorlagenform) sowie Stolpersteine
// (eigener Aufbau, siehe unten).
//
// WOFÜR: Naturdenkmale sind geschützte Einzelobjekte — eine tausendjährige
// Linde, ein Findling, eine Felsnase. Sie eignen sich als Ankerpunkte für
// Aufträge und Figuren, die Spieler auf besondere Orte aufmerksam machen.
//
// WARUM NICHT ÜBER DIE GEOSEARCH, die der POI-Agent schon nutzt: Die fragt
// „welche ARTIKEL haben hier Koordinaten". Naturdenkmale haben fast nie einen
// eigenen Artikel — sie sind Zeilen in einer Gemeindeliste. Gemessen am
// 21.09.2026: Die GeoSearch liefert im 10-km-Umkreis von Neuwied 50 Artikel,
// davon NULL Naturdenkmale; die Liste der Gemeinde führt zehn.
//
// WARUM NICHT ÜBER OPENSTREETMAP: Dort stehen im selben Ausschnitt sieben
// Bäume mit `denotation=natural_monument`, davon vier mit Namen — und ohne
// amtliche Kennung und ohne Beschreibung. Die Wikipedia-Liste ist die
// vollständigere Quelle; OSM kann später ergänzen (Stammumfang, Pflanzjahr).
//
// DER GLÜCKSFALL: Diese Listen sind keine Fliesstexte, sondern strukturierte
// Vorlagen mit benannten Parametern und Koordinaten in Dezimalgrad:
//
//     {{Naturdenkmalliste Rheinland-Pfalz Tabellenzeile
//      | Nummer = ND-7138-406
//      | Bezeichnung = Gerichtslinde
//      | Beschreibung = ''[[Linden (Botanik)|Tilia sp.]]''; alte [[Gerichtslinde]]
//      | Ortsteil = [[Wollendorf]]
//      | Adresse = Feldkircher Straße, bei Nr. 89
//      | NS = 50.452227
//      | EW = 7.432314
//      }}
//
// Über 500 Gemeindelisten nutzen dieselbe Vorlage — ein Parser deckt
// Rheinland-Pfalz ab. Andere Bundesländer haben eigene Vorlagen; deren Namen
// stehen in `VORLAGEN` und lassen sich dort ergänzen.
//
// LIZENZ: Wikipedia-Inhalte stehen unter CC BY-SA. Wer Beschreibungen
// übernimmt, nennt die Quelle — `HERKUNFT` gehört an jedes übernommene Feld.

export const HERKUNFT = 'Wikipedia (CC BY-SA)'

/**
 * Listenarten, die dieselbe Vorlagenform benutzen.
 *
 * Gemessen am 21.09.2026: „Liste der Kulturdenkmäler in Neuwied" nutzt
 * `Denkmalliste Rheinland-Pfalz Tabellenzeile` — dieselbe Form wie die
 * Naturdenkmale, nur mit ein paar Feldern mehr (`Baujahr`). Derselbe Zerleger
 * liest dort 179 Einträge mit Koordinaten. Ein neuer Listentyp ist damit ein
 * Eintrag in dieser Tabelle, kein neuer Parser.
 *
 * `art` wandert bis in den Inhaltsfilter durch (`state.monument_kind`) — daran
 * unterscheidet der Spieler Natur- von Kulturdenkmal.
 */
export const LISTENARTEN = [
  { art: 'nature',   vorlage: 'Naturdenkmalliste Rheinland-Pfalz Tabellenzeile', titel: (g) => `Liste der Naturdenkmale in ${g}` },
  { art: 'cultural', vorlage: 'Denkmalliste Rheinland-Pfalz Tabellenzeile',      titel: (g) => `Liste der Kulturdenkmäler in ${g}` },
]

/** Vorlagennamen, die eine Denkmal-Zeile einleiten. */
export const VORLAGEN = LISTENARTEN.map(l => l.vorlage)

/**
 * Vorlagen-Parameter zerlegen — und zwar klammerbewusst.
 *
 * DIE FALLE: Ein naives `split('|')` zerreisst genau die Zeilen, auf die es
 * ankommt. `Beschreibung = ''[[Linden (Botanik)|Tilia sp.]]''` enthält einen
 * senkrechten Strich INNERHALB eines Wikilinks; danach stünde die Beschreibung
 * als zwei halbe Parameter da. Deshalb wird mitgezählt, wie tief wir in
 * `[[…]]` und `{{…}}` stecken, und nur auf Ebene null getrennt.
 *
 * @param {string} inhalt  Inneres der Vorlage, ohne die äusseren Klammern
 * @returns {Record<string, string>}
 */
export function parameterAus(inhalt) {
  const teile = []
  let tiefe = 0, akt = ''
  const s = String(inhalt ?? '')
  for (let i = 0; i < s.length; i++) {
    const zwei = s.slice(i, i + 2)
    if (zwei === '[[' || zwei === '{{') { tiefe++; akt += zwei; i++; continue }
    if (zwei === ']]' || zwei === '}}') { tiefe--; akt += zwei; i++; continue }
    if (s[i] === '|' && tiefe <= 0) { teile.push(akt); akt = ''; continue }
    akt += s[i]
  }
  teile.push(akt)

  const raus = {}
  for (const t of teile) {
    const g = t.indexOf('=')
    if (g < 0) continue
    raus[t.slice(0, g).trim()] = t.slice(g + 1).trim()
  }
  return raus
}

/**
 * Wiki-Auszeichnung zu lesbarem Text.
 *
 * `[[Ziel|Anzeige]]` → „Anzeige", `[[Ziel]]` → „Ziel", `''kursiv''` → „kursiv".
 * Fussnoten und Kommentare fliegen raus — sie sind für eine Beschriftung im
 * Gelände nur Rauschen.
 */
export function klartext(roh) {
  return String(roh ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Dezimalgrad lesen — die Listen führen sie bereits so.
 *
 * DER LEERE STRING MUSS VORHER RAUS: `Number('')` ist **0**, nicht NaN. Ohne
 * diese Zeile bekäme ein Denkmal mit fehlender Koordinate die Lage 0°/0° —
 * Golf von Guinea — und niemand sähe dem Datensatz an, dass die Angabe fehlt.
 * Ein leeres Feld kommt in diesen Listen vor (`| Bild =` steht überall leer).
 */
const grad = (v) => {
  const s = String(v ?? '').replace(',', '.').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Alle Naturdenkmal-Zeilen eines Listen-Wikitexts.
 *
 * OHNE KOORDINATEN KEIN EINTRAG: Ein Denkmal, das nirgends steht, lässt sich
 * weder anzeigen noch als Ankerpunkt nutzen. Solche Zeilen kommen vor und
 * werden übergangen, nicht geraten.
 *
 * ERLOSCHENE STEHEN IN EINEM EIGENEN ABSCHNITT — und das ist keine Feinheit:
 * Ein Werkzeug, das für den Schutz besonderer Orte sensibilisieren soll, darf
 * nicht behaupten, etwas sei geschützt, dessen Rechtsverordnung aufgehoben
 * wurde. Die Neuwieder Liste führt zwölf Zeilen, von denen eine unter
 * „Ehemalige Naturdenkmale" steht. Sie kommt mit, aber als `erloschen: true`
 * — weggelassen wäre sie ebenfalls eine Aussage, nämlich über Vollständigkeit.
 *
 * @param {string} wikitext
 * @param {string} [quelle]  Seitentitel, wandert als `liste` mit
 * @returns {Array<object>}
 */
export function zeilenAus(wikitext, quelle = '') {
  const s = String(wikitext ?? '')
  const raus = []

  // Wo beginnt der Abschnitt der erloschenen Denkmale? Alles ab dort gilt als
  // aufgehoben. `Infinity`, wenn es ihn nicht gibt.
  const abErloschen = (() => {
    const m = /^=+\s*Ehemalige[^=]*=+\s*$/im.exec(s)
    return m ? m.index : Infinity
  })()

  for (const { art, vorlage } of LISTENARTEN) {
    let i = 0
    for (;;) {
      const start = s.indexOf('{{' + vorlage, i)
      if (start < 0) break
      // Bis zur schliessenden Klammer DIESER Vorlage — mitzählen, weil im
      // Inneren weitere `{{…}}` stehen dürfen.
      let tiefe = 0, ende = -1
      for (let k = start; k < s.length - 1; k++) {
        if (s.slice(k, k + 2) === '{{') { tiefe++; k++; continue }
        if (s.slice(k, k + 2) === '}}') { tiefe--; k++; if (tiefe === 0) { ende = k + 1; break } }
      }
      if (ende < 0) break
      i = ende

      const inhalt = s.slice(start + 2 + vorlage.length, ende - 2)
      const p = parameterAus(inhalt)
      const lat = grad(p.NS), lon = grad(p.EW)
      if (lat === null || lon === null) continue

      const bezeichnung = klartext(p.Bezeichnung)
      if (!bezeichnung) continue

      raus.push({
        art,
        nummer: klartext(p.Nummer),
        bezeichnung,
        beschreibung: klartext(p.Beschreibung),
        ortsteil: klartext(p.Ortsteil),
        adresse: klartext(p.Adresse),
        artikel: klartext(p.Artikel),
        baujahr: klartext(p.Baujahr),   // nur Kulturdenkmäler führen es
        bild: (p.Bild || '').trim(),
        commonscat: (p.Commonscat || '').trim(),
        lat, lon,
        erloschen: start > abErloschen,
        liste: quelle,
        herkunft: HERKUNFT,
      })
    }
  }
  return raus
}

/** Seitentitel der Naturdenkmal-Liste einer Gemeinde. */
export const listenTitel = (gemeinde) => `Liste der Naturdenkmale in ${String(gemeinde || '').trim()}`

/** Eine Wikipedia-Seite als Wikitext, oder null wenn es sie nicht gibt. */
async function wikitext(titel, { fetchImpl = fetch, lang = 'de', userAgent = 'Ajna' } = {}) {
  const p = new URLSearchParams({
    action: 'parse', page: titel, prop: 'wikitext',
    format: 'json', formatversion: '2', redirects: '1',
  })
  const r = await fetchImpl(`https://${lang}.wikipedia.org/w/api.php?${p}`,
    { headers: { 'User-Agent': userAgent } })
  if (!r.ok) throw Object.assign(new Error(`Wikipedia HTTP ${r.status}`), { status: r.status })
  const j = await r.json()
  // `missingtitle` heisst: keine Liste für diese Gemeinde. Kein Grund zu lärmen.
  if (j?.error?.code === 'missingtitle') return null
  if (j?.error) throw new Error(`Wikipedia: ${j.error.code}`)
  return j?.parse?.wikitext ?? ''
}

/**
 * Alle Denkmallisten einer Gemeinde holen und zerlegen — Natur UND Kultur.
 *
 * Für viele Gemeinden gibt es nur eine der beiden oder keine; das ist eine
 * Fehlanzeige, kein Fehler. Eine fehlende Seite kostet nur eine schnelle
 * Absage, deshalb wird schlicht beides versucht.
 *
 * @param {string} gemeinde
 * @param {{fetchImpl?: Function, lang?: string, userAgent?: string}} [opts]
 */
export async function holeListe(gemeinde, opts = {}) {
  const g = String(gemeinde || '').trim()
  const denkmale = []
  const titel = []
  // Stolpersteine: eigene Seite, eigener Aufbau (siehe `stolpersteineAus`).
  const tS = `Liste der Stolpersteine in ${g}`
  const wtS = await wikitext(tS, opts)
  if (wtS !== null) {
    titel.push(tS)
    denkmale.push(...stolpersteineAus(wtS, tS))
  }

  for (const l of LISTENARTEN) {
    const t = l.titel(g)
    const wt = await wikitext(t, opts)
    if (wt === null) continue
    titel.push(t)
    // Je Seite NUR die dort erwartete Vorlage lesen: Eine Kulturdenkmal-Liste
    // kann am Rand eine Naturdenkmal-Zeile enthalten und umgekehrt — wer beides
    // überall liest, zählt dieselbe Zeile zweimal.
    for (const d of zeilenAus(wt, t)) if (d.art === l.art) denkmale.push(d)
  }
  return { titel: titel.join(' + '), denkmale }
}

// ─── Von der Koordinate zur Gemeindeliste ─────────────────────────────────
//
// Die Listen heissen nach GEMEINDEN, der Agent arbeitet aber mit Koordinaten.
// Dazwischen steht eine Rückwärts-Geokodierung — und die trifft nicht immer
// auf Anhieb den richtigen Seitennamen: Nominatim meldet für einen Weiler das
// Dorf, die Liste liegt aber bei der Ortsgemeinde oder der Stadt. Deshalb
// liefert `gemeindeKandidaten` MEHRERE Namen, vom Kleinsten zum Grössten, und
// der Aufrufer probiert sie der Reihe nach. Eine fehlende Seite kostet nur
// eine schnelle Absage.

/** Ortsnamen aus einer Nominatim-Adresse, vom Kleinsten zum Grössten. */
export function gemeindeKandidaten(adresse) {
  // KEIN `county`: Der Seitenname wäre „Liste der Naturdenkmale in Landkreis X",
  // und so heisst keine Seite — Kreislisten heißen „… im Landkreis X". Ein
  // Kandidat, der nie trifft, kostet nur eine Abfrage je Gegend.
  const felder = ['village', 'town', 'city', 'municipality', 'borough']
  const raus = []
  for (const f of felder) {
    const v = String(adresse?.[f] ?? '').trim()
    // Gemeindeverbände heissen in Nominatim oft „Verbandsgemeinde X" — die
    // Wikipedia-Liste steht unter dem blossen Namen.
    const rein = v.replace(/^(Verbandsgemeinde|Stadt|Gemeinde)\s+/i, '').trim()
    if (rein && !raus.includes(rein)) raus.push(rein)
  }
  return raus
}

/**
 * Gemeinde(n) zu einer Koordinate — eine Nominatim-Abfrage.
 *
 * Der Aufrufer ist fürs Zwischenspeichern und den Mindestabstand zuständig
 * (Nominatim verlangt beides); diese Funktion fragt schlicht.
 */
export async function holeGemeinden(lat, lon, { fetchImpl = fetch, userAgent = 'Ajna' } = {}) {
  const p = new URLSearchParams({
    format: 'jsonv2', lat: String(lat), lon: String(lon),
    zoom: '10', addressdetails: '1', 'accept-language': 'de',
  })
  const r = await fetchImpl(`https://nominatim.openstreetmap.org/reverse?${p}`,
    { headers: { 'User-Agent': userAgent } })
  if (!r.ok) throw Object.assign(new Error(`Nominatim HTTP ${r.status}`), { status: r.status })
  const j = await r.json()
  return gemeindeKandidaten(j?.address)
}

// ─── Stolpersteine ────────────────────────────────────────────────────────
//
// Anders gebaut als die Denkmallisten: Es gibt keine Zeilen-Vorlage, sondern
// eine echte Wikitext-Tabelle. Je ADRESSE steht eine `{{Coordinate}}` mit
// `rowspan`, darunter eine `{{PersonZelle}}` je Mensch.
//
// DIE EINHEIT IST DER ORT, nicht die Person. In der Alleestraße 41 in Engers
// liegen vier Steine für vier Mitglieder einer Familie — vier Objekte auf
// derselben Koordinate wären in der Welt ein einziger Punkt, der dreimal
// verdeckt wird. Ein Objekt, das die Namen trägt, ist die ehrlichere
// Darstellung: So liegen die Steine auch im Gehweg, nebeneinander.

/** `{{PersonZelle|Vorname|Nachname|…}}` → „Vorname Nachname". */
function personenAus(abschnitt) {
  const namen = []
  for (const m of String(abschnitt).matchAll(/\{\{PersonZelle\s*\|([^}]*)\}\}/g)) {
    const teile = m[1].split('|').map(x => x.trim()).filter(x => x && !x.includes('='))
    const name = teile.slice(0, 2).join(' ').trim()
    if (name) namen.push(klartext(name))
  }
  return namen
}

/**
 * Stolperstein-Orte einer Listenseite.
 *
 * @param {string} wikitext
 * @param {string} [quelle]  Seitentitel
 */
export function stolpersteineAus(wikitext, quelle = '') {
  const s = String(wikitext ?? '')
  const raus = []
  // Auf `{{Coordinate` teilen: Jeder Abschnitt gehört zu genau einer Adresse
  // und endet dort, wo die nächste beginnt.
  const stuecke = s.split(/(?=\{\{Coordinate)/)
  for (const stueck of stuecke) {
    if (!stueck.startsWith('{{Coordinate')) continue
    const ende = stueck.indexOf('}}')
    if (ende < 0) continue
    const p = parameterAus(stueck.slice('{{Coordinate'.length, ende))
    const lat = Number(String(p.NS ?? '').trim()), lon = Number(String(p.EW ?? '').trim())
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!p.NS && !p.EW)) continue

    const personen = personenAus(stueck)
    // Der `name`-Parameter trägt bereits „Stolpersteine <Adresse>, <Ort>".
    const bezeichnung = klartext(p.name) || 'Stolpersteine'
    raus.push({
      art: 'stolperstein',
      nummer: '',
      bezeichnung,
      beschreibung: personen.length
        ? `Verlegt für ${personen.join(', ')}.`
        : '',
      personen,
      ortsteil: '', adresse: '', artikel: '', baujahr: '', bild: '', commonscat: '',
      lat, lon,
      erloschen: false,
      liste: quelle,
      herkunft: HERKUNFT,
    })
  }
  return raus
}
