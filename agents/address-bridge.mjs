#!/usr/bin/env node
//
// address-bridge — Adress-Anreicherung als Spielfunktion und Datenschutz-Demo.
//
// WAS ER TUT: An einem getragenen Werkzeug („Adress-Lupe") schlägt er nach,
// welche Adressen im Umkreis liegen, und trägt dazu öffentlich verfügbare
// Angaben zusammen — Gewerbe aus OpenStreetMap, das Impressum der gefundenen
// Webseite, Registerdaten, im erweiterten Modus auch Telefonbucheinträge.
//
// WOZU: Zum Spielen, und um vorzuführen, wie viel sich über eine Adresse
// zusammensetzen lässt, ohne irgendetwas zu umgehen. Wie `ais-vesselfinder.mjs`
// ist er NICHT für eine öffentliche Bereitstellung gedacht. Das ist eine
// Betriebszusage, keine `.gitignore`-Regel: Er liegt regulär im Repo, er wird
// nur nicht angeboten.
//
// DIE DREI REGELN, die diesen Agenten von einem Auskunftswerkzeug unterscheiden
// (ausführlich in `docs/fluechtige-daten.md`):
//
//   1. NICHTS BLEIBT LIEGEN. Ergebnisse gehen als flüchtige Nachricht an das
//      EINE Konto, das gefragt hat. Sie landen nie in einem Weltobjekt, nie im
//      gespeicherten Verlauf, nie in einem Cache auf Platte.
//   2. DAS PROTOKOLL HÄLT DIE TATSACHE FEST, NICHT DIE WERTE. Sonst schafft
//      ausgerechnet der Nachweis der Sparsamkeit die Ablage, die vermieden
//      werden sollte.
//   3. JEDES FELD TRÄGT SEINE HERKUNFT. Das ist der Unterschied zwischen einem
//      Auskunftswerkzeug und einer Vorführung: Der Betrachter sieht nicht nur,
//      WAS zusammenkommt, sondern DASS jedes Stück offen herumlag.
//
// Das Werkzeug-OBJEKT ist die Zugangskontrolle: Wer es nicht hat, erreicht die
// Funktion nicht. Es löst aus — es trägt nie ein Ergebnis.
//
// EINE LUPE, DIE DEN BESITZER WECHSELT (entschieden, nicht zufällig): Sie ist
// `portable`, und Aufnehmen überträgt in Ajna den Besitz („Loot: Eigentum
// übergeht auf den Sammler", main.pb.js). Die Lupe wandert also von Hand zu
// Hand, und wer sie gerade hat, darf sie auch verschieben.
//
// Zwei Folgen, die man kennen muss:
//   • Der AGENT verliert die Rechteverwaltung an seinem eigenen Werkzeug,
//     sobald es jemand aufnimmt. Das ist kein Fehler — die Stellen, die
//     schreiben wollen, weichen darauf aus, statt bei jedem Start zu scheitern.
//   • Es gibt EINE Lupe. Wer sie im Inventar behält, hat sie allen anderen
//     weggenommen. Weitere Lupen für weitere Spieler sind vorgemerkt
//     (docs/arbeitspakete.md), aber nicht gebaut.
//
// Die ACE (`authenticated`: view, Aktionen lookup/examine) überlebt den
// Besitzwechsel — sie hängt am Objekt, nicht am Besitzer. Deshalb können auch
// andere Spieler die Lupe weiter benutzen, obwohl sie einem gehört. Verschieben
// darf nur, wer sie besitzt; für alle anderen ist der Weg dahin, sie
// aufzunehmen und woanders abzulegen.
//
// Quellenlage, Rechtsfragen und die Begründung der Modi:
// `docs/adress-anreicherung-quellen.md`.

import { bootAgent, publishManifest } from './lib/agent-base.mjs'
import { Konfig } from './lib/konfig.mjs'
import { Quellcache, istAbgeriegelt } from './lib/quellcache.mjs'
import { readAgentEnv, writeAgentEnv } from './lib/env.mjs'
import { makeRl, ask, confirm, banner, header, hint, ok, warnLine, infoLine, C } from './lib/setup-wizard.mjs'
import * as kataster from './lib/hauskoordinaten.mjs'
import { abstandM, adressenAus, telefonbuchUrl, namenAus, eintraegeAus, alsText, registerFelder, hatAusfall,
         radiusPruefen, RADIUS_MIN, RADIUS_MAX, RADIUS_VORGABE } from './lib/adresse.mjs'

const AGENT = 'address-bridge'

// ─── Einrichtung: der Datenschutz-Hinweis steht VOR den Fragen ────────────
//
// Bewusst nicht als Fußnote am Ende: Wer den Agenten einrichtet, entscheidet in
// diesem Moment über den Modus, und die Tragweite gehört davor, nicht danach.

function datenschutzHinweis() {
  header('Bevor du einrichtest')
  console.log(`Dieser Agent trägt Angaben über ADRESSEN zusammen. Alles davon ist
öffentlich und auch von Hand abrufbar — nichts wird umgangen oder entsperrt.

Trotzdem entsteht dabei etwas Neues: Einzelne offene Angaben werden zu einem
Bild über einen Ort und die Menschen dort. Dass Daten öffentlich sind, ist für
sich genommen KEINE Rechtsgrundlage, sie beliebig zu verarbeiten.

${C.cyan}Verantwortlich bist du als Betreiber${C.reset} — du bestimmst Zweck und Mittel,
nicht die Ajna-Instanz und nicht der Client.

Der Agent hält von sich aus drei Regeln ein:
  • Ergebnisse gehen flüchtig an genau EIN Konto — das, welches gefragt hat.
  • Sie landen nie in einem Weltobjekt und nie im gespeicherten Verlauf.
  • Personenbezogenes wird nie auf Platte zwischengespeichert.
`)
  hint('Ausführlich: docs/adress-anreicherung-quellen.md und docs/fluechtige-daten.md')
}

function modusHinweis() {
  header('Die beiden Betriebsarten')
  console.log(`${C.green}gewerbe${C.reset}    (Vorgabe) — OpenStreetMap, Impressum, Handelsregister.
             Angaben, die jemand von Gesetzes wegen veröffentlichen MUSS.
             Enthält Personennamen (Geschäftsführer) — rechtmäßig
             veröffentlicht, aber personenbezogen.

${C.yellow}erweitert${C.reset}  — zusätzlich die Rückwärtssuche im Telefonbuch.
             Die Einträge sind Opt-in, aber:
             · die AGB der Seite dürften automatisiertes Auslesen untersagen
             · §104 TKG regelt Nummer→Name; Adresse→Name ist nicht erfasst
             Beides ist ungeklärt und liegt bei dir.
`)
}

const setup = {
  need: ['AJNA_USER', 'AJNA_PASS'],
  run: async () => {
    banner(`Ajna · ${AGENT} — Einrichtung`, 'Enter übernimmt den [Vorschlag].')
    datenschutzHinweis()

    const rl = makeRl()
    try {
      const e = { ...readAgentEnv(AGENT) }
      const vorgabe = (k, d = '') => process.env[k] || e[k] || d

      header('Zugang')
      e.AJNA_URL = await ask(rl, 'AJNA_URL', vorgabe('AJNA_URL', 'http://127.0.0.1:8090'))
      e.AJNA_USER = await ask(rl, 'AJNA_USER (Konto des Agenten)', vorgabe('AJNA_USER'))
      e.AJNA_PASS = await ask(rl, 'AJNA_PASS', vorgabe('AJNA_PASS'))

      modusHinweis()
      const gewaehlt = await ask(rl, 'ADR_MODUS (gewerbe|erweitert)', vorgabe('ADR_MODUS', 'gewerbe'))
      e.ADR_MODUS = gewaehlt === 'erweitert' ? 'erweitert' : 'gewerbe'

      if (e.ADR_MODUS === 'erweitert') {
        warnLine('Erweiterter Modus: Du fragst damit Einträge zu PRIVATPERSONEN ab.')
        console.log('  Die beiden offenen Rechtsfragen oben hast du gelesen.')
        const j = await confirm(rl, '  Auf eigene Verantwortung fortfahren?', false)
        if (!j) {
          e.ADR_MODUS = 'gewerbe'
          infoLine('Auf "gewerbe" zurückgesetzt.')
        }
      }

      header('Suchumkreis')
      console.log(`Wie weit um die Lupe herum wird gesammelt? 25 m ist ein Haus mit
seinen Nachbarn, 100 m ein halber Strassenzug.

Ein weiter Umkreis bedeutet nicht nur mehr Treffer, sondern auch mehr Abfragen
bei den Quellen — und die drosseln. ${RADIUS_MAX} m sind die Obergrenze.`)
      e.ADR_RADIUS_M = String(radiusPruefen(await ask(rl, 'ADR_RADIUS_M (Meter)', vorgabe('ADR_RADIUS_M', String(RADIUS_VORGABE)))))

      header('Nutzungsregeln der Quellen')
      console.log(`Nominatim und Overpass verlangen eine identifizierende Kennung mit
Kontaktmöglichkeit. Ohne sie sperren beide früher oder später aus — zu Recht.`)
      e.ADR_KONTAKT = await ask(rl, 'ADR_KONTAKT (E-Mail für den User-Agent)', vorgabe('ADR_KONTAKT'))

      const pfad = writeAgentEnv(AGENT, e, `${AGENT} — erneut einrichten mit --setup`)
      console.log('')
      ok(`Konfiguration gespeichert: ${pfad}`)
      if (e.ADR_MODUS === 'erweitert') warnLine('Betriebsart: erweitert (Personendaten).')
      console.log('')
      return { exit: false }
    } finally {
      rl.close()
    }
  },
}

const { ajna, log, warn } = await bootAgent(AGENT, {
  tag: 'adresse',
  handle: 'address-bridge',
  setup,
  connect: true,
})

// ─── Regler ───────────────────────────────────────────────────────────────
// Eigene Einstellungen, kein Instanz-Zustand: Zwei Betreiber desselben Agenten
// sollen verschiedene Modi fahren können, ohne sich zu stören.

// name: [Env-Name, Vorgabe, Leseart, Notiz]
const R = {
  modus:       ['ADR_MODUS',     'gewerbe', 'text',   'gewerbe | erweitert — erweitert schlägt auch Privatpersonen nach'],
  radius_m:    ['ADR_RADIUS_M',  RADIUS_VORGABE, 'zahl',   `Umkreis der Adressliste in Metern (${RADIUS_MIN}–${RADIUS_MAX})`],
  halten_m:    ['ADR_HALTEN_M',  15,        'zahl',   'Erst nach dieser Bewegung des Werkzeugs neu abfragen'],
  max_treffer: ['ADR_MAX',       8,         'ganz',   'Höchstzahl angezeigter Adressen je Abfrage'],
  kontakt:     ['ADR_KONTAKT',   '',        'text',   'Kontaktadresse im User-Agent (Overpass/Nominatim verlangen sie)'],
  protokoll:   ['ADR_PROTOKOLL', true,      'jaNein', 'Abfragen protokollieren (Tatsachen, nie Werte)'],
  // Leer = an den üblichen Orten unter .cache/ suchen.
  register_db:    ['ADR_REGISTER_DB',    '',           'text', 'Pfad zum OffeneRegister-Abzug (leer = .cache/ durchsuchen)'],
  // Steht an JEDEM Feld aus dem Abzug. Wer eine neuere Fassung einspielt, muss
  // diesen Wert mitziehen — sonst behauptet die Anzeige ein falsches Datum.
  register_stand: ['ADR_REGISTER_STAND', '21.10.2022', 'text', 'Stand des Registerabzugs, erscheint in jeder Ausgabe'],
  // Nur im Modus `erweitert` wirksam: Adressen ohne Telefonbucheintrag weglassen.
  // Sonst besteht eine Auskunft ueberwiegend aus „kein Eintrag" — Rauschen, das
  // die wenigen echten Treffer zudeckt.
  nur_mit_eintrag: ['ADR_NUR_MIT_EINTRAG', true, 'jaNein', 'erweitert: nur Adressen MIT Telefonbucheintrag zeigen'],
}

const konf = await Konfig.eigene(ajna, {
  praefix: 'adr',
  log: (m) => log(`Konfig: ${m}`),
})
// Leer angelegt: Ein leerer Eintrag ist ein Formularfeld, kein Wert — er zeigt,
// woran man drehen kann, und lässt die `.env` in Ruhe, bis jemand dreht.
await konf.saee(Object.entries(R).map(([name, [envName, vorgabe, , note]]) => ({ name, envName, vorgabe, note })))

const w = (k) => { const [envName, vorgabe, art] = R[k]; return konf[art](k, envName, vorgabe) }

const istErweitert = () => w('modus') === 'erweitert'

// ─── Amtliche Hausnummern ─────────────────────────────────────────────────
//
// OSM fuehrt in weiten Teilen keine Hausnummern; das Kataster schon. Fehlt der
// Abzug, ist das kein Fehler — der Agent nimmt dann OSM und die Geokodierung
// wie bisher. Siehe `lib/hauskoordinaten.mjs`.
const katasterDb = await kataster.oeffne({ log: (m) => log(m) })

const USER_AGENT = () => {
  const kontakt = w('kontakt').trim()
  return `Ajna-address-bridge/1.0 (${kontakt || 'kein Kontakt hinterlegt'})`
}

// Ein Moduswechsel im laufenden Betrieb ist eine Entscheidung mit Tragweite —
// er gehört sichtbar ins Protokoll, nicht still in die Datenbank.
let gemeldeterModus = w('modus')
konf.beiAenderung(() => {
  if (w('modus') === gemeldeterModus) return
  gemeldeterModus = w('modus')
  log(`Betriebsart gewechselt: ${istErweitert() ? 'erweitert (auch Personendaten)' : 'gewerbe'}`)
})

if (!w('kontakt').trim()) {
  warn('ADR_KONTAKT ist leer. Nominatim und Overpass verlangen eine Kennung mit ' +
       'Kontaktmöglichkeit — ohne sie wird dieser Agent früher oder später ausgesperrt.')
}
log(`Betriebsart: ${istErweitert() ? 'erweitert (auch Personendaten)' : 'gewerbe'}`)
// Der Umkreis steht in drei Schubladen (.env, agent_settings, Vorgabe). Welche
// gerade gilt, soll man nicht raten muessen.
log(`Suchumkreis: ${radiusPruefen(w('radius_m'))} m`)

// ─── Quellen-Caches ───────────────────────────────────────────────────────
//
// ORTSDATEN dürfen auf Platte: Eine Adresse zieht nicht um, und nach dem ersten
// Besucher kostet dieselbe Stelle niemanden mehr etwas.
//
// PERSONENDATEN dürfen es NICHT. Ein Zwischenspeicher Adresse→Person *ist* eine
// Profildatenbank, gleich woher die Einzelteile stammen. Deshalb hat die
// Telefonbuch-Quelle unten gar keinen Cache — nicht einmal einen kurzen.

const orte = new Quellcache('adresse-orte', {
  ttlMs: 12 * 3600_000,
  minAbstandMs: 1100,        // Overpass-Nutzungsregel: nicht hämmern
  maxDateien: 4000,
  log: (m) => log(`Ortscache: ${m}`),
})

// EIGENER VORRAT FUER DEN RUECKFALL, und das ist kein Detail: Er hing zuerst am
// selben Cache wie Overpass — und damit an derselben Sperre. Wird Overpass
// gedrosselt (`sperre(15 min)`), war genau der Weg mitgesperrt, der fuer diesen
// Fall gebaut wurde. Getrennte Namen heissen getrennte Budgets und getrennte
// Sperren; Nominatim hat ohnehin eine eigene Regel (1 Anfrage/s).
const geokod = new Quellcache('adresse-geokodierung', {
  ttlMs: 7 * 24 * 3600_000,   // eine Adresse zieht nicht um
  minAbstandMs: 1100,
  maxDateien: 2000,
  log: (m) => log(`Geokodierung: ${m}`),
})

const register = new Quellcache('adresse-register', {
  ttlMs: 7 * 24 * 3600_000,  // Registerdaten ändern sich selten
  minAbstandMs: 1100,
  maxDateien: 2000,
  log: (m) => log(`Registercache: ${m}`),
})

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

// TOTE SPIEGEL KOSTEN ZEIT, DIE DER SPIELER WARTET.
//
// Gemessen: Der erste Spiegel antwortet in unter einer Sekunde, die beiden
// anderen liefen in 30 s Zeitablauf — beide. Faellt der erste einmal aus, hing
// eine Abfrage damit ueber eine Minute, und der Spieler sah nur „fehlgeschlagen".
//
// Deshalb: kuerzere Frist je Spiegel, und wer gerade nicht antwortet, wird fuer
// eine Weile uebersprungen. Dasselbe Muster wie in `server/geo.js`, das dort
// aus demselben Grund entstanden ist.
// GEMESSEN: Eine kalte Abfrage braucht auf overpass-api.de gut 13 Sekunden, die
// gleiche warm eine. Zwoelf Sekunden waren deshalb zu scharf — sie liessen den
// EINZIGEN funktionierenden Spiegel durchfallen. Die Frist darf grosszuegig
// sein, weil das Gedaechtnis unten dafuer sorgt, dass ein toter Spiegel sie nur
// EINMAL je Pause kostet.
const SPIEGEL_FRIST_MS = 25_000
const SPIEGEL_PAUSE_MS = 5 * 60_000
const spiegelTot = new Map()   // URL → Zeitpunkt, ab dem wieder probiert wird

async function holeJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT(), Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 20_000),
  })
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e }
  return res.json()
}

async function holeText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT(), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 15_000),
  })
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e }
  return res.text()
}

// ─── Schicht A+B: Adressen und Gewerbe aus OpenStreetMap ──────────────────
//
// EIN Aufruf für beides. Overpass liefert die MENGE der Adressen im Umkreis —
// genau das, was bei ±10 m GPS-Genauigkeit nötig ist: Ein einzelnes Ergebnis
// wäre eine selbstbewusst aussehende Lüge, eine Liste zeigt die Unschärfe.
// Die POI-Merkmale (Name, Telefon, Webseite, Öffnungszeiten) hängen an
// denselben Elementen und kosten nichts extra.

async function adressenImUmkreis(lat, lon, radiusM) {
  // Auf ~10 m gerundeter Schlüssel: Zwei Spieler an derselben Hausecke teilen
  // sich die Antwort, statt zweimal zu fragen.
  const key = `umkreis:${lat.toFixed(4)}:${lon.toFixed(4)}:${radiusM}`
  const abfrage = async () => {
    const q = `[out:json][timeout:25];
(
  node(around:${radiusM},${lat},${lon})["addr:housenumber"];
  way(around:${radiusM},${lat},${lon})["addr:housenumber"];
);
out center tags;`
    let letzterFehler = null
    for (const url of OVERPASS) {
      const tot = spiegelTot.get(url) || 0
      if (tot > Date.now()) continue   // antwortet gerade nicht, spaeter wieder
      try {
        const antwort = await holeJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          timeoutMs: SPIEGEL_FRIST_MS,
        })
        spiegelTot.delete(url)
        return antwort
      } catch (err) {
        letzterFehler = err
        if (istAbgeriegelt(err)) { await orte.sperre(15 * 60_000); throw err }
        spiegelTot.set(url, Date.now() + SPIEGEL_PAUSE_MS)
        log(`Overpass-Spiegel ${new URL(url).host} antwortet nicht (${err.message}) — 5 min übersprungen`)
      }
    }
    throw letzterFehler || new Error('kein Overpass-Spiegel erreichbar')
  }

  // `daten === null` heisst NICHT „keine Adresse", sondern „konnte nicht
  // fragen" — Budget aufgebraucht oder Quelle gesperrt (Quellcache liefert dann
  // `{daten: null, grund}`). Das als leere Liste durchzureichen war ein Fehler:
  // Eine Drosselung erschien als Tatsache über den Ort. Genau davor warnt dieser
  // Agent an jeder anderen Stelle.
  const { daten, grund } = await orte.hole(key, abfrage)
  if (daten == null) {
    log(`Kartenquelle nicht abgefragt: ${grund || 'kein Ergebnis'}`)
    return null
  }
  return adressenAus(daten, lat, lon, w('max_treffer') || 8)
}

// ─── Schicht B: Impressum ─────────────────────────────────────────────────
//
// Die sauberste Anreicherung, die es gibt: §5 DDG VERPFLICHTET dazu, genau
// diese Angaben zur Identifikation zu veröffentlichen. Wer hier etwas findet,
// liest, was jemand veröffentlichen musste — nicht, was ihm entglitten ist.
//
// Zugleich die unbequeme Lehre der Vorführung: Bei Einzelunternehmen im
// Homeoffice ist das die Wohnadresse und der bürgerliche Name.

const IMPRESSUM_PFADE = ['/impressum', '/impressum.html', '/impressum/', '/legal/impressum']

async function impressum(webseite) {
  if (!webseite) return []
  let basis
  try { basis = new URL(webseite.startsWith('http') ? webseite : `https://${webseite}`) }
  catch { return [] }

  for (const pfad of IMPRESSUM_PFADE) {
    try {
      const html = await holeText(new URL(pfad, basis).href, { timeoutMs: 8000 })
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ')
                       .replace(/\s+/g, ' ')
      const f = []
      const nimm = (feld, m) => { if (m) f.push({ feld, wert: m.trim(), herkunft: 'Impressum (§5 DDG)' }) }
      nimm('Vertreten durch', (text.match(/Vertreten durch:?\s*([^.;]{3,80})/i) || [])[1])
      nimm('Registereintrag', (text.match(/\b(HRA|HRB|VR|GnR)\s*\d{1,8}\b/i) || [])[0])
      nimm('Umsatzsteuer-ID', (text.match(/\bDE\s?\d{9}\b/) || [])[0])
      nimm('Telefon', (text.match(/(?:Tel(?:efon)?\.?:?)\s*(\+?[\d\s\/()-]{7,24})/i) || [])[1])
      if (f.length) return f
    } catch { /* nächster Pfad */ }
  }
  return []
}

// ─── Schicht B: Handelsregister aus dem OffeneRegister-Abzug ──────────────
//
// WARUM LOKAL STATT ÜBER HTTP: `db.offeneregister.de` antwortet mit 502 — die
// Abfrage-Schnittstelle des Projekts liegt, und darauf zu warten hiesse, die
// Quelle auf unbestimmte Zeit auszulassen. Der Komplettabzug ist dagegen da:
// 3,7 GB SQLite, gelesen mit `node:sqlite` (in Node eingebaut, keine neue
// Abhängigkeit). Nebeneffekt, der das Ganze erst richtig macht: Ein lokaler
// Abzug erzeugt bei niemandem Last und kennt keine Nutzungsgrenzen.
//
// ZWEI DINGE, DIE NICHT VERHANDELBAR SIND:
//
//   • DER STAND STEHT AN JEDEM FELD. Der Abzug hinkt dem amtlichen Register um
//     Jahre hinterher. Eine veraltete Angabe ohne Datum ist schlimmer als gar
//     keine — sie sieht aus wie eine Auskunft über heute.
//   • EINE FEHLENDE DATEI IST EIN AUSFALL, KEINE FEHLANZEIGE. „Kein Eintrag"
//     wäre eine Aussage über die Firma, die wir ohne Datenbank nicht treffen
//     können. Dieselbe Regel wie beim Telefonbuch-Parser.
//
// Bezugsquelle und Stand: `docs/adress-anreicherung-quellen.md`.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HIER = dirname(fileURLToPath(import.meta.url))

/** Übliche Ablageorte, wenn `adr.register_db` nichts sagt. */
const REGISTER_ORTE = [
  join(HIER, '..', '.cache', 'handelsregister.db'),
  join(HIER, '..', '.cache', 'offeneregister', 'handelsregister.db'),
]

// Einmal öffnen, dann halten. `_versucht` verhindert, dass ein fehlender Abzug
// bei jeder Adresse erneut gesucht und erneut gemeldet wird.
let _registerDb = null
let _registerVersucht = false
let _registerGrund = ''

function registerDb() {
  if (_registerVersucht) return _registerDb
  _registerVersucht = true
  const gewaehlt = w('register_db').trim()
  const kandidaten = gewaehlt ? [gewaehlt] : REGISTER_ORTE
  const pfad = kandidaten.find(p => existsSync(p))
  if (!pfad) {
    _registerGrund = 'Abzug nicht gefunden'
    warn(`Handelsregister-Abzug nicht gefunden (gesucht: ${kandidaten.join(', ')}). ` +
         'Die Registerquelle meldet bis dahin einen Ausfall — siehe docs/adress-anreicherung-quellen.md.')
    return null
  }
  try {
    _registerDb = new DatabaseSync(pfad, { readOnly: true })
    log(`Handelsregister-Abzug geöffnet: ${pfad} (Stand ${w('register_stand')})`)
  } catch (err) {
    _registerGrund = err.message
    warn(`Handelsregister-Abzug nicht lesbar: ${err.message}`)
  }
  return _registerDb
}

/**
 * Firma im Abzug suchen — nur mit Adress-Gegenprobe.
 *
 * DIE FALLE, die der erste Probelauf offengelegt hat: Die Volltextsuche trifft
 * grosszuegig. „ReThink" lieferte fuenf Firmen in Muenchen und Berlin. Eine
 * davon einer Adresse in Koblenz zuzuschreiben, waere eine erfundene
 * Verbindung — und sie saehe aus wie eine Auskunft.
 *
 * Deshalb wird jeder Treffer gegen die POSTLEITZAHL geprueft, an der wir
 * stehen. Passt sie nicht, gilt der Treffer nicht. Und haben wir gar keine
 * Postleitzahl, wird NICHTS behauptet: Ohne Gegenprobe keine Aussage.
 *
 * `isCurrent` ist im Abzug die Zeichenkette "True"/"False", kein Wahrheitswert —
 * ein Vergleich auf Wahrheit wuerde jede Zeile durchlassen, auch die historischen.
 */
function firmaSuchen(db, name, plz) {
  if (!plz) return null
  const phrase = '"' + String(name).replace(/"/g, '""') + '"'
  let treffer = []
  try {
    treffer = db.prepare('SELECT companyId FROM NamesFts WHERE NamesFts MATCH ? LIMIT 10').all(phrase)
  } catch { return null }   // FTS mag manche Zeichen nicht — dann eben nichts

  const eins = (sql, id) => { try { return db.prepare(sql).get(id) ?? null } catch { return null } }

  for (const { companyId } of treffer) {
    const adr = eins(
      "SELECT fullAddress, zipCode, zipAndPlace FROM Addresses WHERE companyId = ? AND isCurrent = 'True' LIMIT 1",
      companyId)
    const registerPlz = String(adr?.zipCode || '').trim() ||
                        (String(adr?.zipAndPlace || '').match(/\b(\d{5})\b/) || [])[1] || ''
    if (registerPlz !== String(plz).trim()) continue   // andere Stadt → nicht unsere Firma

    const aktuell = eins("SELECT name FROM Names WHERE companyId = ? AND isCurrent = 'True' LIMIT 1", companyId)
    const ref = eins(
      "SELECT nativeReferenceNumber FROM ReferenceNumbers WHERE companyId = ? AND (validTill IS NULL OR validTill = '') LIMIT 1",
      companyId)
    const c = eins('SELECT foundedDate, dissolutionDate FROM Companies WHERE companyId = ? LIMIT 1', companyId)

    const firma = aktuell?.name || name
    return {
      firma,
      // Die Volltextsuche trifft auch FRUEHERE Firmierungen. Wer unter dem alten
      // Namen sucht und den neuen praesentiert bekommt, haelt das fuer einen
      // Fehler — also wird der Unterschied gesagt, nicht verschwiegen.
      frueher: firma.toLowerCase() === String(name).toLowerCase() ? '' : String(name),
      register: ref?.nativeReferenceNumber || '',
      anschrift: adr?.fullAddress || '',
      gegruendet: c?.foundedDate || '',
      aufgeloest: c?.dissolutionDate || '',
    }
  }
  return null
}

async function handelsregister(firmenname, plz) {
  if (!firmenname) return []
  const db = registerDb()
  const stand = w('register_stand')
  const herkunft = `OffeneRegister (Abzug ${stand})`

  if (!db) {
    return [{ feld: 'Handelsregister', wert: `nicht abrufbar (${_registerGrund})`,
              herkunft: 'OffeneRegister', ausfall: true }]
  }

  const key = `firma:${firmenname.toLowerCase()}:${plz || ''}`
  try {
    // Über den Quellcache, obwohl lokal gelesen wird: Die Suche geht über
    // Millionen Zeilen, und dieselbe Firma wird bei jeder Abfrage derselben
    // Adresse erneut gesucht.
    const { daten } = await register.hole(key, async () => firmaSuchen(db, firmenname, plz))
    return registerFelder(daten, stand)
  } catch (err) {
    return [{ feld: 'Handelsregister', wert: `Abfrage fehlgeschlagen (${err.message})`,
              herkunft, ausfall: true }]
  }
}

// ─── Schicht C: Rückwärtssuche im Telefonbuch (nur `erweitert`) ───────────
//
// BEWUSST OHNE JEDEN CACHE — auch ohne kurzen. Ein Zwischenspeicher
// Adresse→Person wäre eine Profildatenbank, und der Sinn dieses Agenten ist das
// Gegenteil. Jede Abfrage ist eine Abfrage, und danach ist sie fort.
//
// Die Einträge sind Opt-in: Wer dort steht, hat der Veröffentlichung
// zugestimmt. Ungeklärt bleiben die AGB der Seite und ob §104 TKG die Richtung
// Adresse→Name mitträgt — siehe `docs/adress-anreicherung-quellen.md`.
//
// BRUCHGEFAHR: Es gibt kein JSON-LD, geparst wird gegen `*sort`-Attribute im
// Markup. Das bricht bei jedem Redesign der Seite. Deshalb liefert diese
// Funktion im Zweifel NICHTS und meldet das — nie Unsinn, der wie eine Auskunft
// aussieht.

// Mindestabstand zwischen zwei Abfragen. KEIN Cache — ein Zwischenspeicher
// Adresse->Person waere die Profildatenbank, deren Gegenteil der Zweck ist.
// Aber acht Anfragen in einer Sekunde sind unhoeflich, auch wenn die Seite sie
// hinnimmt. Eine Warteschlange kostet nichts und legt nichts ab.
let _tbLetzte = 0
async function tbAbstand(ms = 700) {
  const warten = _tbLetzte + ms - Date.now()
  if (warten > 0) await new Promise(r => setTimeout(r, warten))
  _tbLetzte = Date.now()
}

async function telefonbuch(adresse) {
  if (!istErweitert()) return []
  if (!adresse.plz || !adresse.strasse) return []
  const url = telefonbuchUrl(adresse.plz, adresse.strasse, adresse.hausnummer)
  try {
    await tbAbstand()
    const html = await holeText(url, { timeoutMs: 12_000 })
    const treffer = eintraegeAus(html).slice(0, 5)
    if (!treffer.length) {
      return [{ feld: 'Telefonbuch', wert: 'kein Eintrag', herkunft: 'Das Telefonbuch (Eintrag freiwillig)' }]
    }
    const HERKUNFT = 'Das Telefonbuch (Eintrag freiwillig)'
    const felder = []
    for (const e of treffer) {
      felder.push({ feld: 'Eintrag', wert: e.name, herkunft: HERKUNFT, person: true })
      if (e.telefon) felder.push({ feld: 'Telefon', wert: e.telefon, herkunft: HERKUNFT, person: true })
      if (e.link) felder.push({ feld: 'Eintrag ansehen', wert: e.link, herkunft: HERKUNFT, person: true, link: true })
    }
    // NACHSCHLAGEN MUSS IMMER MOEGLICH SEIN. Die Detailseite steht nicht in
    // jedem Block der Trefferliste; ohne Rueckfall stuende dann eine Angabe da,
    // die sich nicht ueberpruefen laesst. Die Suchseite selbst fuehrt zu
    // denselben Treffern — EINMAL, nicht je Eintrag.
    if (!felder.some(f => f.link)) {
      felder.push({ feld: 'Eintrag ansehen', wert: url, herkunft: HERKUNFT, person: true, link: true })
    }
    return felder
  } catch (err) {
    // GEMESSEN: Die Seite antwortet mit 410 (und 404), wenn zu einer Adresse
    // nichts vorliegt — der Rumpf ist dann die generische Suchseite, keine
    // Trefferliste. Reproduzierbar je Adresse, auch mit Sekunden Abstand; es ist
    // also keine Drosselung. Das als „nicht abrufbar" auszugeben war falsch:
    // eine Fehlanzeige als Ausfall verkleidet, und die Anzeige bestand fast nur
    // noch aus Warnzeichen.
    if (err.status === 410 || err.status === 404) {
      return [{ feld: 'Telefonbuch', wert: 'kein Eintrag',
                herkunft: 'Das Telefonbuch (Eintrag freiwillig)' }]
    }
    // Alles andere BLEIBT ein Ausfall. Eine Sperre oder ein gebrochener Parser
    // ist keine Aussage über die Adresse.
    return [{ feld: 'Telefonbuch', wert: `nicht abrufbar (${err.message})`,
              herkunft: 'Das Telefonbuch', ausfall: true }]
  }
}

// ─── Auskunft zusammenstellen ─────────────────────────────────────────────

// ─── Rückfall: Nominatim, wenn OSM nichts hergibt ─────────────────────────
//
// WOFÜR NICHT: nicht für bessere Genauigkeit. Nominatim baut selbst auf OSM auf
// und findet kein Gebäude, das dort fehlt — es fällt dann auf Straßen- oder
// Ortsebene zurück, ist also GRÖBER.
//
// WOFÜR DANN: für Abdeckung (ländlich, unkartiert) und Ausfallsicherheit
// (Overpass gedrosselt oder aus). Beides liefert eine ungefähre Lage, und genau
// so wird sie gekennzeichnet — `genauigkeit: 'ungefaehr'` reicht bis in die
// Anzeige durch. Eine Schätzung, die aussieht wie eine Hausnummer, wäre der
// Fehler, den dieser Agent überall sonst vermeidet.
//
// Nominatim erlaubt EINE Anfrage pro Sekunde. Deshalb nur, wenn Overpass leer
// blieb, und über denselben Ortscache.

async function nominatimRueckfall(lat, lon) {
  const key = `nominatim:${lat.toFixed(4)}:${lon.toFixed(4)}`
  try {
    const { daten } = await geokod.hole(key, async () => holeJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18`,
      { timeoutMs: 12_000 }))
    const a = daten?.address
    if (!a) return []
    const strasse = a.road || a.pedestrian || a.footway || ''
    if (!strasse && !a.village && !a.town && !a.city) return []
    return [{
      lat: Number(daten.lat) || lat,
      lon: Number(daten.lon) || lon,
      strasse,
      hausnummer: a.house_number || '',
      plz: a.postcode || '',
      ort: a.city || a.town || a.village || a.municipality || '',
      entfernungM: Math.round(abstandM(lat, lon, Number(daten.lat) || lat, Number(daten.lon) || lon)),
      genauigkeit: a.house_number ? 'ungefaehr' : 'grob',
      gewerbe: [],
    }]
  } catch {
    return []
  }
}

/**
 * Gewerbe-Angaben aus OSM an die Kataster-Adressen haengen.
 *
 * Zusammengefuehrt wird ueber Strasse + Hausnummer; wo OSM keine Adresse
 * traegt (ein POI-Punkt ohne addr:*), entscheidet die Naehe. 20 Meter, weil
 * ein Ladeneingang nicht im Gebaeudemittelpunkt liegt.
 */
function gewerbeAnhaengen(adressen, osm) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
  for (const o of osm) {
    if (!o.gewerbe?.length) continue
    let ziel = adressen.find(a =>
      norm(a.strasse) === norm(o.strasse) && norm(a.hausnummer) === norm(o.hausnummer))
    if (!ziel) {
      let beste = Infinity
      for (const a of adressen) {
        const d = abstandM(a.lat, a.lon, o.lat, o.lon)
        if (d < beste && d <= 20) { beste = d; ziel = a }
      }
    }
    if (ziel) ziel.gewerbe = [...(ziel.gewerbe || []), ...o.gewerbe]
  }
}

/**
 * Postleitzahl fuer eine Gegend — EINE Abfrage, nicht eine je Adresse.
 *
 * Das Kataster fuehrt keine; die Telefonbuch-URL braucht sie. Innerhalb weniger
 * hundert Meter ist sie dieselbe, also genuegt ein Blick, und der liegt danach
 * eine Woche im Vorrat. Klappt es nicht, bleibt die Adresse ohne PLZ — dann
 * unterbleibt die Telefonbuch-Suche, statt eine falsche zu raten.
 */
async function plzFuer(lat, lon) {
  try {
    const treffer = await nominatimRueckfall(lat, lon)
    return treffer[0]?.plz || ''
  } catch { return '' }
}

async function auskunft(lat, lon) {
  // Auch hier begrenzen, nicht nur im Einrichter: Der Wert kann aus der
  // `.env` ODER aus `agent_settings` kommen, und die Datenbank laeuft am
  // Einrichter vorbei.
  const radius = radiusPruefen(w('radius_m'))
  const max = w('max_treffer') || 8

  // 1. ADRESSEN AUS DEM KATASTER — amtlich, vollstaendig, lokal, in Millisekunden.
  let adressen = kataster.adressenImUmkreis(katasterDb, lat, lon, radius, max)

  // 2. OSM: nicht fuer die Adressen, sondern fuer das GEWERBE (Name, Telefon,
  //    Webseite, Oeffnungszeiten). Das kann das Kataster nicht.
  //
  // EIN FEHLER IST AUCH „KONNTE NICHT FRAGEN": Ein Zeitablauf flog frueher bis
  // zum Spieler durch, statt den Rueckfall auszuloesen.
  let osm = null
  try {
    osm = await adressenImUmkreis(lat, lon, radius)
  } catch (err) {
    log(`Kartenquelle fehlgeschlagen: ${err.message}`)
  }
  const kartenquelleAus = osm === null && !adressen.length

  if (adressen.length) {
    if (osm?.length) gewerbeAnhaengen(adressen, osm)
    // Die Datei fuehrt keine Postleitzahl; die Telefonbuch-Suche braucht eine.
    // Sie ist ortsteilweit gleich — also EINE Abfrage fuer alle.
    const plz = await plzFuer(lat, lon)
    if (plz) for (const a of adressen) if (!a.plz) a.plz = plz
  } else {
    adressen = (osm && osm.length) ? osm : await nominatimRueckfall(lat, lon)
    // Alle stumm: Das ist ein Ausfall, keine Fehlanzeige.
    if (!adressen.length) return { adressen: [], radius, quelleAus: kartenquelleAus }
  }

  for (const a of adressen) {
    const felder = [...a.gewerbe]
    const web = felder.find(f => f.feld === 'Webseite')?.wert
    if (web) felder.push(...await impressum(web))
    const firma = felder.find(f => f.feld === 'Name')?.wert
    if (firma) felder.push(...await handelsregister(firma, a.plz))
    felder.push(...await telefonbuch(a))
    a.felder = felder
  }

  // NUR ADRESSEN MIT EINTRAG — im erweiterten Modus, auf Wunsch abschaltbar.
  //
  // Eine Strasse liefert leicht acht Adressen, von denen sieben „kein Eintrag"
  // sagen. Das Rauschen deckt die wenigen echten Treffer zu.
  //
  // WEGGELASSENE WERDEN GEZAEHLT, NICHT VERSCHWIEGEN: Eine Zeile am Ende sagt,
  // wie viele geprueft wurden und nichts hatten. Stilles Verschwinden waere
  // wieder eine Aussage ohne Beleg — diesmal ueber die Vollstaendigkeit.
  let verborgen = 0
  const alle = adressen          // vor dem Filtern — fuer das Protokoll
  if (istErweitert() && w('nur_mit_eintrag')) {
    const mitEintrag = adressen.filter(a =>
      (a.felder || []).some(f => f.feld === 'Eintrag' || f.ausfall))
    verborgen = adressen.length - mitEintrag.length
    adressen = mitEintrag
  }
  return { adressen, radius, verborgen, alle }
}

// ─── Protokoll: Tatsachen, nie Werte ──────────────────────────────────────

function protokolliere(adresseKurz, anzahl, felderNamen) {
  if (!w('protokoll')) return
  const felder = [...new Set(felderNamen)].join(', ') || '—'
  log(`Abfrage ${adresseKurz} → ${anzahl} Treffer (${felder})`)
}

// ─── Das Werkzeug ─────────────────────────────────────────────────────────
//
// Ein aufnehmbares Objekt. Es ist die Zugangskontrolle: Wer es nicht trägt,
// erreicht die Funktion nicht. Und es ist NUR Auslöser — in seinen Feldern
// steht nie ein Ergebnis.

// AUFNEHMEN STEHT HIER NICHT DRIN, und das ist kein Versehen: Der Client bietet
// es ueber `state.portable` an (ObjectActions: `isOwner || state.portable`),
// nicht ueber eine Aktion. Eine Aktion namens "collect" waere ein Knopf ohne
// Draht gewesen - genau so ist es beim ersten Versuch passiert.
const AKTIONEN = [
  { key: 'lookup', label: 'Nachschlagen' },
  { key: 'examine', label: 'Untersuchen' },
]

/** Die Eigenschaften, die ein Werkzeug tragen MUSS, damit es benutzbar ist. */
const WERKZEUG_STATE = {
  source: AGENT,        // Haken fuer den Inhaltsfilter
  quelle: AGENT,        // eigener Marker (Wiedererkennung beim Start)
  werkzeug: true,
  portable: true,       // ← macht es aufnehmbar, auch fuer fremde Konten
  realtime: true,       // Verschwinden wird mitbekommen
  archetype: 'item',    // sonst blendet der Filter es als "Nachzuegler" aus
  actions: AKTIONEN,
  hinweis: 'Zeigt öffentliche Angaben zur Adresse, an der sie liegt. Die Anzeige wird nicht gespeichert.',
}

// NUR `view`. `move` stand hier kurz mit drin — der Gedanke war, dass jeder die
// Lupe hinstellen darf, ohne sie zu besitzen. Gemessen: Eine ACE fuer
// `authenticated` ergibt KEIN Schreibrecht, weil `objects.updateRule` implizite
// Audiences nicht auswerten kann (Migration 1788600000). Das Recht zu vergeben
// haette nur bewirkt, dass der Client den Verschiebe-Greifer anbietet und das
// Speichern scheitert.
//
// Gebraucht wird es auch nicht: Wer die Lupe aufnimmt, wird ihr BESITZER
// ("Loot: Eigentum uebergeht auf den Sammler") und darf damit ohnehin alles.
const RECHTE = ['view']

async function ensureAce(objId) {
  const keys = AKTIONEN.map(a => a.key)
  const gleicheRechte = (r) => RECHTE.every(x => (r || []).includes(x))
  try {
    const vorhanden = await ajna.listPermissions(objId)
    const ace = vorhanden.find(a => a.subject_type === 'authenticated' && !a.subject)
    if (ace) {
      const gleich = JSON.stringify(ace.interact_actions || []) === JSON.stringify(keys)
      if (!gleich || !gleicheRechte(ace.rights)) {
        await ajna.updatePermission(ace.id, { rights: RECHTE, interact_actions: keys })
      }
    } else {
      await ajna.addPermission(objId, { subject_type: 'authenticated', rights: RECHTE, interact_actions: keys })
    }
  } catch (err) {
    // NICHT MEHR UNSER OBJEKT: Wer ein `portable`-Objekt aufnimmt, wird sein
    // BESITZER (main.pb.js: „Loot: Eigentum uebergeht auf den Sammler"). Nimmt
    // ein Spieler die Lupe auf, verliert der Agent damit die Rechteverwaltung
    // an seinem eigenen Werkzeug — und scheiterte hier bei jedem Start erneut.
    //
    // Das ist kein Fehler des Agenten, sondern eine Folge davon, dass ein
    // Werkzeug wie Beute behandelt wird. Einmal sagen, dann Ruhe: Der neue
    // Besitzer hat ohnehin alle Rechte, die Lupe funktioniert weiter.
    const meins = ajna.currentUser?.()?.id
    const obj = ajna.getObjects?.().find(o => o.id === objId)
    if (obj && meins && obj.owner !== meins) {
      log(`Werkzeug ${objId} gehoert inzwischen einem Spieler — Rechte bleiben, wie sie sind.`)
    } else {
      warn(`Rechte am Werkzeug: ${err?.response?.data?.message || err?.message || err}`)
    }
  }
}

async function werkzeugSichern() {
  const meine = ajna.getObjects().filter(o => o.state?.quelle === AGENT && o.state?.werkzeug)
  if (meine.length) {
    // NACHRUESTEN: Werkzeuge aus der Zeit vor dem Inhaltsfilter tragen kein
    // `state.source`. Ohne das greift AgentFilters.matches() nicht — sie
    // blieben sichtbar, auch wenn der Spieler den Agenten abgewaehlt hat, und
    // die Sperre waere ein Papiertiger.
    const ich = ajna.currentUser?.()?.id
    for (const o of meine) {
      const fehlt = Object.entries(WERKZEUG_STATE)
        .filter(([k, v]) => typeof v !== 'object' && o.state?.[k] !== v)
        .map(([k]) => k)
      const typFehlt = o.type !== 'item'
      if (!fehlt.length && !typFehlt) continue
      // EIN AUFGENOMMENES WERKZEUG GEHOERT NICHT MEHR UNS. Aufnehmen uebertraegt
      // den Besitz (main.pb.js: „Loot: Eigentum uebergeht auf den Sammler"), und
      // das ist so gewollt — die Lupe wandert von Hand zu Hand. Ein Schreibversuch
      // liefe dann jedes Mal in dieselbe Absage.
      if (ich && o.owner !== ich) {
        log(`Werkzeug ${o.id} gehoert einem Spieler — ${fehlt.join(', ') || 'type'} bleibt ungeaendert.`)
        continue
      }
      try {
        await ajna.updateObject(o.id, {
          ...(typFehlt ? { type: 'item' } : {}),
          state: { ...o.state, ...WERKZEUG_STATE },
        })
        log(`Werkzeug ${o.id} nachgezogen: ${[...fehlt, ...(typFehlt ? ['type'] : [])].join(', ')}`)
      } catch (err) {
        warn(`Werkzeug ${o.id} nicht nachgezogen: ${err?.message || err}`)
      }
    }
    return meine
  }

  const startLat = Number(process.env.ADR_START_LAT || 50.3569)
  const startLon = Number(process.env.ADR_START_LON || 7.5890)
  const obj = await ajna.createObject({
    name: 'Adress-Lupe',
    lat: startLat, lon: startLon, altitude: 0,
    type: 'item',
    description: 'Adress-Lupe — zeigt, was über diese Adresse öffentlich bekannt ist.',
    state: { ...WERKZEUG_STATE },
    appearance: { emoji: '🔎', color: '#ffd479', scale: 1, label: 'Adress-Lupe' },
  })
  await ensureAce(obj.id)
  log(`Werkzeug angelegt: ${obj.id} @ ${startLat.toFixed(5)}, ${startLon.toFixed(5)}`)
  return [obj]
}

// ─── Auslöser ─────────────────────────────────────────────────────────────

// Letzte Fundstelle je Werkzeug: Erst nach `halten_m` Metern wird neu gefragt.
// Wiederholtes Anstupsen kostet damit nichts.
const letzteStelle = new Map()   // objektId → {lat, lon, erg}

function darfWiederverwenden(id, lat, lon) {
  const alt = letzteStelle.get(id)
  if (!alt) return null
  // EIN FEHLSCHLAG WIRD NICHT WIEDERVERWENDET.
  //
  // Sonst konserviert die Abkuerzung eine Stoerung: Eine einmal gescheiterte
  // Abfrage kam bei jedem weiteren Anstupsen sofort zurueck — gemeldet als
  // „nicht abrufbar (timeout)" an einer Stelle, an der die Quelle in 0,27 s
  // antwortete. Wer es noch einmal versucht, will es noch einmal VERSUCHEN.
  if (hatAusfall(alt.erg)) { letzteStelle.delete(id); return null }
  const halten = w('halten_m') || 15
  return abstandM(alt.lat, alt.lon, lat, lon) <= halten ? alt.erg : null
}

/**
 * Was der Client zum ZEICHNEN braucht — je Adresse Position, Lage-Güte und
 * Felder. Bewusst schlank: Der Text bleibt die lesbare Rückfallebene, `meta`
 * trägt nur, was ein Marker ohne Neuberechnung setzen kann.
 */
function alsMarker(erg) {
  return (erg.adressen || []).map(a => ({
    lat: a.lat, lon: a.lon,
    titel: [a.strasse, a.hausnummer].filter(Boolean).join(' ') || a.ort || 'Adresse',
    ort: [a.plz, a.ort].filter(Boolean).join(' '),
    genauigkeit: a.genauigkeit || 'genau',
    felder: (a.felder || a.gewerbe || []).map(f => ({
      feld: f.feld, wert: f.wert, herkunft: f.herkunft,
      ausfall: !!f.ausfall, link: !!f.link,
    })),
  }))
}

async function bearbeite(objektId, nutzerId, lat, lon) {
  if (!nutzerId) return   // anonym: es gibt niemanden, dem man flüchtig antworten könnte
  let erg = darfWiederverwenden(objektId, lat, lon)
  if (erg === null) {
    erg = await auskunft(lat, lon)
    letzteStelle.set(objektId, { lat, lon, erg })
    const felder = erg.adressen.flatMap(a => (a.felder || []).map(f => f.feld))
    const erste = erg.adressen[0]
    protokolliere(erste ? `${erste.plz || '?'} ${erste.strasse} ${erste.hausnummer}` : `${lat.toFixed(4)},${lon.toFixed(4)}`,
                  erg.adressen.length, felder)
  }

  // FLÜCHTIG und an genau ein Konto. Nicht `interact:` — das ginge an alle
  // Abonnenten des Objekts, und eine Auskunft im Auftrag einer Person geht
  // niemanden sonst etwas an.
  //
  // `meta.adressen` trägt dieselben Angaben strukturiert, damit der Client
  // Marker setzen kann. Es ist DIESELBE flüchtige Nachricht — für die Marker
  // gilt damit dieselbe Zusage wie für den Text.
  await ajna.sendChat(nutzerId, {
    text: alsText(erg),
    object: objektId,
    meta: {
      adressen: alsMarker(erg),
      // ALLE geprueften Adressen, auch die vom Filter entfernten — fuers
      // Protokoll unter „Alle". Ohne das saehe man dort nur die Ueberlebenden
      // und wuesste nicht, was ueberhaupt nachgeschlagen wurde.
      geprueft: (erg.alle || []).map(a => ({
        titel: [a.strasse, a.hausnummer].filter(Boolean).join(' ') || a.ort || 'Adresse',
        ort: [a.plz, a.ort].filter(Boolean).join(' '),
        genauigkeit: a.genauigkeit || 'genau',
        felder: (a.felder || a.gewerbe || []).length,
        entfernungM: a.entfernungM,
      })),
      werkzeug: objektId,
    },
    ephemeral: true,
  })
}

// ─── Am Inhaltsfilter anmelden ────────────────────────────────────────────
//
// Damit taucht der Agent im Filter-Dialog auf und laesst sich abwaehlen. Der
// Schalter ist zugleich die Zugangssperre: Ist er aus, blendet der Client das
// Werkzeug aus — und ohne Werkzeug gibt es keinen Weg zur Abfrage.
//
// EHRLICH DAZU: Der Filter ist eine geraetelokale Vorliebe (localStorage), kein
// Recht. Er steuert, was ANGEZEIGT und damit antippbar ist. Wer eine harte
// Grenze braucht, braucht das Rechtemodell (ACE), nicht den Filter.
if (await publishManifest(ajna, {
  source: AGENT,
  agent_name: 'Adress-Lupe',
  description: 'Zeigt oeffentliche Angaben zur Adresse, an der die Lupe liegt. ' +
               'Ergebnisse werden nicht gespeichert.',
  layers: [{ key: 'all', label: 'Adress-Lupe', predicate: null }],
}, warn)) log('am Inhaltsfilter angemeldet')

const werkzeuge = await werkzeugSichern()
for (const werkzeug of werkzeuge) {
  await ensureAce(werkzeug.id)
  await ajna.onInteract(werkzeug.id, async (evt) => {
    if (evt.action !== 'lookup') return
    try {
      // Die Position kommt vom OBJEKT, nicht vom Spieler: Der Agent erfährt so
      // nie, wo jemand steht — nur, wo er sein Werkzeug hingelegt hat.
      const akt = ajna.getObjects().find(o => o.id === werkzeug.id) || werkzeug
      await bearbeite(werkzeug.id, evt.source, Number(akt.lat), Number(akt.lon))
    } catch (err) {
      warn(`Abfrage fehlgeschlagen: ${err?.message || err}`)
      if (evt.source) {
        await ajna.sendChat(evt.source, {
          text: `Nachschlagen fehlgeschlagen: ${err?.message || err}`,
          object: werkzeug.id, ephemeral: true,
        }).catch(() => {})
      }
    }
  })
  log(`hört auf Interaktionen an ${werkzeug.id}`)
}

// KEIN objektloser Kommandoweg.
//
// Es gab ihn: `sendAgentCommand('address-bridge', 'lookup', {lat, lon})` fuer
// den Fall, dass jemand das Werkzeug nicht zur Hand hat. Er ist entfernt, weil
// er die Sperre unterlaufen haette, die der Inhaltsfilter darstellt: Das
// Werkzeug verschwindet, wenn der Spieler diesen Agenten abwaehlt - ein
// Kommando haette trotzdem geantwortet.
//
// Eine Filterwahl liegt geraetelokal (localStorage); ein Agent kann sie nicht
// nachpruefen. Die einzige ehrliche Durchsetzung ist deshalb, dass es nur EINEN
// Weg gibt, und der fuehrt ueber das Objekt.

log('bereit.')

// ─── Was sich im Betrieb drehen lässt ─────────────────────────────────────
//
//   adr.modus        gewerbe | erweitert
//   adr.radius_m     Umkreis der Adressliste in Metern (Vorgabe 25, 5-250);
//                    in agents/.env.address-bridge als ADR_RADIUS_M
//   adr.halten_m     Bewegung, ab der neu gefragt wird (Vorgabe 15)
//   adr.max_treffer  Höchstzahl angezeigter Adressen (Vorgabe 8)
//   adr.kontakt      Kontaktadresse im User-Agent
//   adr.protokoll    Abfragen protokollieren (Tatsachen, nie Werte)
//   adr.register_db     Pfad zum OffeneRegister-Abzug (leer = .cache/ durchsuchen)
//   adr.register_stand  Stand des Abzugs — erscheint in JEDER Ausgabe
