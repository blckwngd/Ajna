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
// Quellenlage, Rechtsfragen und die Begründung der Modi:
// `docs/adress-anreicherung-quellen.md`.

import { bootAgent } from './lib/agent-base.mjs'
import { Konfig } from './lib/konfig.mjs'
import { Quellcache, istAbgeriegelt } from './lib/quellcache.mjs'
import { readAgentEnv, writeAgentEnv } from './lib/env.mjs'
import { makeRl, ask, confirm, banner, header, hint, ok, warnLine, infoLine, C } from './lib/setup-wizard.mjs'
import { abstandM, adressenAus, telefonbuchUrl, namenAus, alsText } from './lib/adresse.mjs'

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
  radius_m:    ['ADR_RADIUS_M',  25,        'zahl',   'Umkreis der Adressliste in Metern'],
  halten_m:    ['ADR_HALTEN_M',  15,        'zahl',   'Erst nach dieser Bewegung des Werkzeugs neu abfragen'],
  max_treffer: ['ADR_MAX',       8,         'ganz',   'Höchstzahl angezeigter Adressen je Abfrage'],
  kontakt:     ['ADR_KONTAKT',   '',        'text',   'Kontaktadresse im User-Agent (Overpass/Nominatim verlangen sie)'],
  protokoll:   ['ADR_PROTOKOLL', true,      'jaNein', 'Abfragen protokollieren (Tatsachen, nie Werte)'],
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
      try {
        return await holeJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          timeoutMs: 25_000,
        })
      } catch (err) {
        letzterFehler = err
        if (istAbgeriegelt(err)) { await orte.sperre(15 * 60_000); throw err }
        // Nächster Spiegel — ein toter Server ist kein Grund aufzugeben.
      }
    }
    throw letzterFehler || new Error('kein Overpass-Spiegel erreichbar')
  }

  const { daten } = await orte.hole(key, abfrage)
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

// ─── Schicht B: Handelsregister über OffeneRegister ───────────────────────
//
// GEMESSEN AM 2026-09-11: `db.offeneregister.de` antwortet mit 502 — die
// Abfrage-Schnittstelle liegt. Genau deshalb ist diese Quelle STECKBAR und ihr
// Ausfall eine Meldung, kein Fehler: Der Rest der Auskunft funktioniert ohne
// sie. Kommt sie zurück, funktioniert sie wieder, ohne dass hier etwas zu
// ändern wäre.
//
// Wenn sie antwortet: Ihr Abzug hinkt dem amtlichen Register um Jahre
// hinterher. Deshalb trägt jedes Feld von hier den Vermerk mit — eine veraltete
// Angabe ohne Datum ist schlimmer als keine.

const OFFENEREGISTER = 'https://db.offeneregister.de/de-companies.json'

async function handelsregister(firmenname) {
  if (!firmenname) return []
  const key = `firma:${firmenname.toLowerCase()}`
  try {
    const { daten } = await register.hole(key, async () => {
      const url = `${OFFENEREGISTER}?_search=${encodeURIComponent(firmenname)}&_size=3&_shape=objects`
      return holeJson(url, { timeoutMs: 12_000 })
    })
    const treffer = daten?.rows?.[0]
    if (!treffer) return []
    const f = []
    const nimm = (feld, wert) => {
      if (wert) f.push({ feld, wert: String(wert), herkunft: 'OffeneRegister (Abzug, ggf. veraltet)' })
    }
    nimm('Firma', treffer.name)
    nimm('Register', [treffer.register_court, treffer.register_number].filter(Boolean).join(' '))
    nimm('Rechtsform', treffer.company_type)
    return f
  } catch (err) {
    return [{ feld: 'Handelsregister', wert: `Quelle nicht erreichbar (${err.message})`,
              herkunft: 'OffeneRegister', ausfall: true }]
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

async function telefonbuch(adresse) {
  if (!istErweitert()) return []
  if (!adresse.plz || !adresse.strasse) return []
  const url = telefonbuchUrl(adresse.plz, adresse.strasse, adresse.hausnummer)
  try {
    const html = await holeText(url, { timeoutMs: 12_000 })
    const eindeutig = namenAus(html).slice(0, 5)
    if (!eindeutig.length) {
      return [{ feld: 'Telefonbuch', wert: 'kein Eintrag', herkunft: 'Das Telefonbuch (Eintrag freiwillig)' }]
    }
    return eindeutig.map(n => ({
      feld: 'Eintrag', wert: n,
      herkunft: 'Das Telefonbuch (Eintrag freiwillig)',
      person: true,
    }))
  } catch (err) {
    // Ein gebrochener Parser oder eine Sperre darf NIE als "kein Eintrag"
    // durchgehen — das wäre eine Aussage, die wir nicht treffen können.
    return [{ feld: 'Telefonbuch', wert: `nicht abrufbar (${err.message})`,
              herkunft: 'Das Telefonbuch', ausfall: true }]
  }
}

// ─── Auskunft zusammenstellen ─────────────────────────────────────────────

async function auskunft(lat, lon) {
  const radius = w('radius_m') || 25
  const adressen = await adressenImUmkreis(lat, lon, radius)
  if (!adressen.length) return { adressen: [], radius }

  for (const a of adressen) {
    const felder = [...a.gewerbe]
    const web = felder.find(f => f.feld === 'Webseite')?.wert
    if (web) felder.push(...await impressum(web))
    const firma = felder.find(f => f.feld === 'Name')?.wert
    if (firma) felder.push(...await handelsregister(firma))
    felder.push(...await telefonbuch(a))
    a.felder = felder
  }
  return { adressen, radius }
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

const AKTIONEN = [
  { key: 'lookup', label: 'Nachschlagen' },
  { key: 'collect', label: 'Aufnehmen' },
  { key: 'examine', label: 'Untersuchen' },
]

async function ensureAce(objId) {
  const keys = AKTIONEN.map(a => a.key)
  try {
    const vorhanden = await ajna.listPermissions(objId)
    const ace = vorhanden.find(a => a.subject_type === 'authenticated' && !a.subject)
    if (ace) {
      const gleich = JSON.stringify(ace.interact_actions || []) === JSON.stringify(keys)
      if (!gleich || !(ace.rights || []).includes('view')) {
        await ajna.updatePermission(ace.id, { rights: ['view'], interact_actions: keys })
      }
    } else {
      await ajna.addPermission(objId, { subject_type: 'authenticated', rights: ['view'], interact_actions: keys })
    }
  } catch (err) {
    warn(`Rechte am Werkzeug: ${err?.response?.data?.message || err?.message || err}`)
  }
}

async function werkzeugSichern() {
  const meine = ajna.getObjects().filter(o => o.state?.quelle === AGENT && o.state?.werkzeug)
  if (meine.length) return meine

  const startLat = Number(process.env.ADR_START_LAT || 50.3569)
  const startLon = Number(process.env.ADR_START_LON || 7.5890)
  const obj = await ajna.createObject({
    name: 'Adress-Lupe',
    lat: startLat, lon: startLon, altitude: 0,
    kind: 'item',
    state: {
      quelle: AGENT,
      werkzeug: true,
      actions: AKTIONEN,
      // Kurz und ohne Fachchinesisch: WAS sie tut, nicht wie sie gebaut ist.
      hinweis: 'Zeigt öffentliche Angaben zur Adresse, an der sie liegt. Die Anzeige wird nicht gespeichert.',
    },
    appearance: { emoji: '🔎', color: '#ffd479', scale: 1 },
  })
  await ensureAce(obj.id)
  log(`Werkzeug angelegt: ${obj.id} @ ${startLat.toFixed(5)}, ${startLon.toFixed(5)}`)
  return [obj]
}

// ─── Auslöser ─────────────────────────────────────────────────────────────

// Letzte Fundstelle je Werkzeug: Erst nach `halten_m` Metern wird neu gefragt.
// Wiederholtes Anstupsen kostet damit nichts.
const letzteStelle = new Map()   // objektId → {lat, lon, text}

function darfWiederverwenden(id, lat, lon) {
  const alt = letzteStelle.get(id)
  if (!alt) return null
  const halten = w('halten_m') || 15
  return abstandM(alt.lat, alt.lon, lat, lon) <= halten ? alt.text : null
}

async function bearbeite(objektId, nutzerId, lat, lon) {
  if (!nutzerId) return   // anonym: es gibt niemanden, dem man flüchtig antworten könnte
  let text = darfWiederverwenden(objektId, lat, lon)
  if (text === null) {
    const erg = await auskunft(lat, lon)
    text = alsText(erg)
    letzteStelle.set(objektId, { lat, lon, text })
    const felder = erg.adressen.flatMap(a => (a.felder || []).map(f => f.feld))
    const erste = erg.adressen[0]
    protokolliere(erste ? `${erste.plz || '?'} ${erste.strasse} ${erste.hausnummer}` : `${lat.toFixed(4)},${lon.toFixed(4)}`,
                  erg.adressen.length, felder)
  }

  // FLÜCHTIG und an genau ein Konto. Nicht `interact:` — das ginge an alle
  // Abonnenten des Objekts, und eine Auskunft im Auftrag einer Person geht
  // niemanden sonst etwas an.
  await ajna.sendChat(nutzerId, { text, object: objektId, ephemeral: true })
}

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

// Objektloser Weg: Wer das Werkzeug nicht zur Hand hat, kann Koordinaten
// ausdrücklich mitschicken. Dass er damit seine Position preisgibt, ist seine
// Entscheidung je Aufruf — deshalb kommen sie aus dem Kommando und nicht aus
// einer Standortabfrage.
await ajna.onAgentCommand(AGENT, async (evt) => {
  if (evt.command !== 'lookup' || !evt.source) return
  const lat = Number(evt.payload?.lat), lon = Number(evt.payload?.lon)
  if (!isFinite(lat) || !isFinite(lon)) return
  try {
    const erg = await auskunft(lat, lon)
    const felder = erg.adressen.flatMap(a => (a.felder || []).map(f => f.feld))
    protokolliere(`${lat.toFixed(4)},${lon.toFixed(4)}`, erg.adressen.length, felder)
    await ajna.sendChat(evt.source, { text: alsText(erg), ephemeral: true })
  } catch (err) {
    warn(`Kommando-Abfrage fehlgeschlagen: ${err?.message || err}`)
  }
})

log('bereit.')

// ─── Was sich im Betrieb drehen lässt ─────────────────────────────────────
//
//   adr.modus        gewerbe | erweitert
//   adr.radius_m     Umkreis der Adressliste (Vorgabe 25)
//   adr.halten_m     Bewegung, ab der neu gefragt wird (Vorgabe 15)
//   adr.max_treffer  Höchstzahl angezeigter Adressen (Vorgabe 8)
//   adr.kontakt      Kontaktadresse im User-Agent
//   adr.protokoll    Abfragen protokollieren (Tatsachen, nie Werte)
