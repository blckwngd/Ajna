#!/usr/bin/env node
// world-cleanup.mjs — Leichen aus der Objektwelt räumen.
//
// WAS EINE LEICHE IST, ist keine Frage des Alters allein. Ein Denkmal von 2024
// ist so gültig wie am ersten Tag; ein gespiegeltes Fahrzeug von vorgestern ist
// Müll. Die Regeln unten unterscheiden danach, WER das Objekt angelegt hat und
// ob es sich von selbst wieder herstellt:
//
//   • Spiegel eines Agenten (Fahrzeuge, Flugzeuge, Schiffe) → weg, entsteht neu
//   • Rückstand aus Testläufen (Konto heisst *@example.invalid o. ä.) → weg
//   • Alles von einem echten Menschen → BLEIBT, ungefragt
//   • UWB-Anker und AR-Marker → BLEIBEN, ausdrücklich geschützt
//
// Trockenlauf per Vorgabe. `--loeschen` führt aus, vorher nicht.
//
//   node tools/world-cleanup.mjs
//   node tools/world-cleanup.mjs --loeschen

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PocketBase from 'pocketbase'
import { loadAgentEnv } from '../agents/lib/env.mjs'
import { maybeReexecWithSystemCa } from '../agents/lib/system-ca.mjs'

loadAgentEnv('cli')
const URL = process.env.AJNA_URL || 'http://127.0.0.1:8090'

const SU = process.env.AJNA_SU, SU_PASS = process.env.AJNA_SU_PASS
const USER = process.env.AJNA_USER, PASS = process.env.AJNA_PASS
const ECHT = process.argv.includes('--loeschen')

// ─── Die Regeln ───────────────────────────────────────────────────────────

/** Typen, die unter keinen Umständen angefasst werden. */
const GESCHUETZTE_TYPEN = new Set(['uwb_anchor', 'marker', 'ar_marker'])

/** Quellen, deren Objekte ein laufender Agent binnen Minuten neu anlegt. */
const SPIEGEL_QUELLEN = new Set(['cits', 'opensky', 'aisstream', 'vesselfinder', 'aprs'])

/**
 * Ortsfeste Spiegel: WLAN-Netze, Denkmäler, Wikipedia-Artikel, POIs.
 *
 * Die wandern nicht und veralten nicht — sie stehen nur möglicherweise am
 * falschen Ort, weil ein Agent um ein falsch eingestelltes Zentrum gesammelt
 * hat. Deshalb ENTSCHEIDET HIER DIE ENTFERNUNG, nicht das Alter: Was in
 * Reichweite liegt, bleibt (es kostet fremdes Kontingent, es neu zu holen);
 * was ausserhalb liegt, hat nie jemand gesehen und wird auch niemand sehen.
 */
const ORTSFESTE_SPIEGEL = new Set(['wigle', 'wikipedia', 'denkmal', 'naturdenkmal', 'overpass'])
const REICHWEITE_KM = Number((process.argv.find(a => a.startsWith('--km=')) || '--km=3').slice(5))

const abstandKm = (lat1, lon1, lat2, lon2) => {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

/** Rückstände aus Testläufen — am Konto erkennbar. */
const TESTKONTO = /@example\.invalid$|^(acl|chat|enf|upd|spoof|stoer|sealtest|vtest|gtest|gast|near|flow|tq|k2?|kette|d|pl|p2|p3|f|zwa|iso|cch|impl|adr|ace|prueflabor|b-quelle)[-0-9]/i

/** Quellen, die nur in Testläufen entstanden sind. */
const TESTQUELLE = /^(b-quelle-|prueflabor-|durchsetzung$|demoquelle$)/

/**
 * Warum fliegt dieses Objekt raus — oder warum nicht?
 * @returns {{weg: boolean, grund: string}}
 */
export function urteil(obj, mailVon, anker = []) {
  const typ = String(obj.type || '')
  const src = obj.state?.source ? String(obj.state.source) : null
  const mail = mailVon(obj.owner) || ''

  if (GESCHUETZTE_TYPEN.has(typ)) return { weg: false, grund: 'geschützter Typ' }

  // Spiegel fliegen immer — unabhängig vom Besitzer. Sie entstehen neu.
  if (src && SPIEGEL_QUELLEN.has(src)) return { weg: true, grund: `Spiegel (${src})` }

  // Ortsfeste Spiegel: hier entscheidet die ENTFERNUNG, nicht das Alter.
  if (src && ORTSFESTE_SPIEGEL.has(src) && anker.length) {
    const km = Math.min(...anker.map(a => abstandKm(a.lat, a.lon, obj.lat, obj.lon)))
    if (km > REICHWEITE_KM) return { weg: true, grund: `${src}, ausser Reichweite (>${REICHWEITE_KM} km)` }
    return { weg: false, grund: `${src}, in Reichweite` }
  }

  // Rückstände aus Testläufen erkennt man an der QUELLE, und die ist eindeutig
  // genug, um vor der Besitzfrage zu stehen: Ein Objekt mit `source:
  // "prueflabor-3v5bc5"` ist Testmüll, auch wenn es unter einem echten Konto
  // entstanden ist — Tests melden sich mit dem an, was gerade zur Hand ist.
  if (src && TESTQUELLE.test(src)) return { weg: true, grund: `Testquelle (${src})` }

  // EIN MENSCH HAT DAS ANGELEGT. Was ein echtes Konto besitzt, gehört ihm —
  // auch wenn es alt ist und auch wenn niemand mehr weiss, wozu es da war.
  if (mail && !TESTKONTO.test(mail)) return { weg: false, grund: 'gehört einem echten Konto' }
  if (mail && TESTKONTO.test(mail)) return { weg: true, grund: 'Testkonto' }
  if (!obj.owner) return { weg: true, grund: 'ohne Besitzer' }
  // Besitzer-Konto gibt es nicht mehr: ein gelöschtes Testkonto hat es hinterlassen.
  if (!mail) return { weg: true, grund: 'Besitzer-Konto existiert nicht mehr' }
  return { weg: false, grund: 'kein Grund gefunden' }
}

// ─── Lauf ─────────────────────────────────────────────────────────────────
//
// In einer Funktion, NICHT auf Modulebene: sonst löscht ein blosses `import`
// dieser Datei die halbe Welt, und die Regeln oben wären nicht prüfbar, ohne
// den ganzen Lauf anzustossen.

async function main() {
  maybeReexecWithSystemCa(URL)

  const pb = new PocketBase(URL)
  if (SU && SU_PASS) await pb.collection('_superusers').authWithPassword(SU, SU_PASS)
  else if (USER && PASS) await pb.collection('users').authWithPassword(USER, PASS)
  else { console.error('AJNA_SU/AJNA_SU_PASS oder AJNA_USER/AJNA_PASS setzen.'); process.exit(2) }

  // DAS URTEIL HÄNGT AN DER KONTEN-LISTE, also muss sie vollständig sein.
//
  // `users` ist für gewöhnliche Konten nicht auflistbar — ein Lauf ohne
  // Superuser bekommt eine leere oder einelementige Liste zurück und hält
  // daraufhin JEDES fremde Objekt für herrenlos. Beim ersten Versuch sah das so
  // aus: „0 Anker", „61 Besitzer-Konto existiert nicht mehr". Beides war falsch,
  // und mit `--loeschen` wäre es teuer geworden.
  let nutzer = []
  try {
    nutzer = await pb.collection('users').getFullList({ fields: 'id,email' })
  } catch (err) {
    console.error(`✗ Konten nicht lesbar: ${err?.message || err}`)
    console.error('  Dieses Werkzeug entscheidet anhand der Besitzer. Ohne die Liste')
    console.error('  wäre jedes Urteil geraten.\n')
    console.error('  AJNA_SU und AJNA_SU_PASS setzen (Superuser der Instanz).')
    process.exit(2)
  }
  const mailVon = (id) => nutzer.find(u => u.id === id)?.email || ''

  const objekte = await pb.collection('objects').getFullList({ sort: '+created' })

  // ANKER = wo wirklich gespielt wird. Die Spielerobjekte echter Konten sagen das
  // ehrlicher als jede .env — ein falsch eingestelltes Zentrum ist ja gerade die
  // Ursache des Durcheinanders.
  const anker = objekte
    .filter(o => o.type === 'player' && mailVon(o.owner) && !TESTKONTO.test(mailVon(o.owner)))
    .map(o => ({ lat: o.lat, lon: o.lon }))
  // ZWEITE SICHERUNG: Auch eine erfolgreiche Abfrage kann unvollständig sein,
  // wenn die Regel nur das eigene Konto durchlässt. Dann kennt die Welt mehr
  // Besitzer als die Konten-Liste Einträge hat — ein Widerspruch, der hier
  // auffallen muss und nicht erst an den gelöschten Objekten.
  const besitzer = new Set(objekte.map(o => o.owner).filter(Boolean))
  const unbekannt = [...besitzer].filter(id => !mailVon(id))
  if (unbekannt.length) {
    console.error(`✗ ${unbekannt.length} von ${besitzer.size} Besitzern sind in der Konten-Liste nicht enthalten`)
    console.error(`  (${nutzer.length} Konten sichtbar). Die Liste ist also beschnitten —`)
    console.error('  jedes Urteil über fremde Objekte wäre geraten.\n')
    console.error('  AJNA_SU und AJNA_SU_PASS setzen (Superuser der Instanz).')
    process.exit(2)
  }

  console.error(`${objekte.length} Objekte geprüft · ${anker.length} Anker (Spielerpositionen echter Konten)`)
  for (const a of anker) console.error(`  Anker ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`)
  console.error('')

  const weg = [], bleibt = new Map()
  for (const o of objekte) {
    const u = urteil(o, mailVon, anker)
    if (u.weg) weg.push({ o, grund: u.grund })
    else bleibt.set(u.grund, (bleibt.get(u.grund) || 0) + 1)
  }

  const nachGrund = new Map()
  for (const { grund } of weg) nachGrund.set(grund, (nachGrund.get(grund) || 0) + 1)

  console.error('WEG:')
  for (const [g, n] of [...nachGrund].sort((a, b) => b[1] - a[1])) console.error(`  ${String(n).padStart(5)}  ${g}`)
  console.error('\nBLEIBT:')
  for (const [g, n] of [...bleibt].sort((a, b) => b[1] - a[1])) console.error(`  ${String(n).padStart(5)}  ${g}`)
  console.error(`\nSumme: ${weg.length} weg, ${objekte.length - weg.length} bleiben`)

  if (!ECHT) {
    console.error('\nProbelauf — nichts geändert. Mit --loeschen ausführen.')
    console.log(JSON.stringify({ geprueft: objekte.length, weg: weg.length, probelauf: true }, null, 2))
    process.exit(0)
  }

  let ok = 0, fehler = 0
  for (const { o } of weg) {
    try { await pb.collection('objects').delete(o.id); ok++ }
    catch (err) { fehler++; if (fehler < 5) console.error(`  ✗ ${o.id}: ${err?.message || err}`) }
    if (ok % 250 === 0 && ok) console.error(`  … ${ok} gelöscht`)
  }
  console.error(`\nGelöscht: ${ok}${fehler ? `, fehlgeschlagen: ${fehler}` : ''}`)
  console.log(JSON.stringify({ geprueft: objekte.length, geloescht: ok, fehler }, null, 2))
}

const direkt = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (direkt) await main()
