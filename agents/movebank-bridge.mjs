#!/usr/bin/env node
//
// agents/movebank-bridge.mjs — GPS-getrackte Wildtiere aus Movebank in Ajna.
//
// Movebank (movebank.org, MPI für Verhaltensbiologie) ist das Archiv der
// Tier-Telemetrie-Forschung: Störche, Adler, Wölfe, Elefanten, Meeresschildkröten
// … Ein Teil der Studien ist öffentlich einsehbar; dieser Agent spiegelt deren
// AKTUELLE Positionen als Ajna-Objekte (type "animal", state.source "movebank").
//
// WICHTIGE EIGENHEITEN DER QUELLE (empirisch ermittelt, nicht aus dem Handbuch):
//   • Die meisten öffentlichen Studien sind ARCHIVE — letzte Fixes oft Jahre alt
//     (Stichprobe: 2980 / 586 / 323 Tage). Echte Live-Feeds sind die Ausnahme.
//     Darum: ENTDECKUNGSLAUF beim Start ermittelt, welche Studien frische Daten
//     haben (MB_MAX_AGE_DAYS); danach werden NUR diese gepollt.
//   • Studien mit `suspend_license_terms = true` sind ohne Lizenz-Handshake
//     abrufbar — nur die nutzen wir.
//   • Die öffentliche Studien-Metadaten-API liefert KEINE Art/Lizenz/Zitat,
//     nur id + name. Die Tierart wird daher aus dem Studiennamen abgeleitet.
//   • Fixes kommen je nach Sender alle 15 min bis mehrere Stunden. Objekte
//     springen deshalb (kein Dead-Reckoning — eine Extrapolation über Stunden
//     wäre erfunden). Das Alter des letzten Fixes steht in der Beschreibung.
//
// ATTRIBUTION: Die Daten gehören den forschenden Instituten. Jedes Objekt trägt
// den Studiennamen; bitte bei Weitergabe die Studie nennen (Movebank-Praxis).
//
// Konfiguration (Env > agents/.env.movebank > Root-.env):
//   MB_MAX_AGE_DAYS   Fix gilt als "aktuell" (Default: 30)
//   MB_POLL_S         Poll-Intervall der Live-Studien (Default: 600)
//   MB_DISCOVER_H     Abstand der Entdeckungsläufe in Stunden (Default: 12)
//   MB_MAX_ANIMALS    Deckel gleichzeitiger Tiere (Default: 150)
//   MB_MAX_STUDIES    Deckel Live-Studien (Default: 25)
//   MB_REQ_DELAY_MS   Pause zwischen Abfragen (Default: 1100 — bitte nicht kürzen)
//   MB_STUDIES        optional: feste Studien-IDs (Komma-Liste) statt Entdeckung
//
// Start:  node agents/movebank-bridge.mjs   bzw.   npm run movebank

import { bootAgent, envNum, envInt, envStr, publishManifest } from './lib/agent-base.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'

const { ajna } = await bootAgent('movebank', {
  tag: 'movebank',
  setup: simpleSetup('movebank', { required: ['AJNA_USER', 'AJNA_PASS'], optional: ['AJNA_URL'] }),
})

const MAX_AGE_MS   = envNum('MB_MAX_AGE_DAYS', 30) * 86400000
const POLL_MS      = Math.max(120, envNum('MB_POLL_S', 600)) * 1000
const DISCOVER_MS  = envNum('MB_DISCOVER_H', 12) * 3600000
const MAX_ANIMALS  = envInt('MB_MAX_ANIMALS', 150)
const MAX_STUDIES  = envInt('MB_MAX_STUDIES', 25)
const REQ_DELAY_MS = Math.max(1000, envInt('MB_REQ_DELAY_MS', 1100))
const FIXED_STUDIES = envStr('MB_STUDIES').split(',').map(s => s.trim()).filter(Boolean)

const SOURCE = 'movebank'
const BASE = 'https://www.movebank.org/movebank/service/public/json'
const UA = { 'User-Agent': 'ajna-movebank-bridge/1.0 (Ajna geo platform; non-commercial)' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Tierart + Symbol aus dem Studiennamen ableiten (die öffentliche API liefert
// kein Taxon). Reihenfolge = Priorität; erste Übereinstimmung gewinnt.
const SPECIES = [
  [/white stork|storch|ciconia/i,        { art: 'Weißstorch',      emoji: '🐦', color: '#f2f2f2' }],
  [/stork/i,                             { art: 'Storch',          emoji: '🐦', color: '#f2f2f2' }],
  [/red kite|milan/i,                    { art: 'Rotmilan',        emoji: '🦅', color: '#c9622f' }],
  [/eagle|adler|aquila|haliaeetus/i,     { art: 'Adler',           emoji: '🦅', color: '#8a6b3f' }],
  [/vulture|geier/i,                     { art: 'Geier',           emoji: '🦅', color: '#7a6a55' }],
  [/falcon|falke|kestrel/i,              { art: 'Falke',           emoji: '🦅', color: '#b58b52' }],
  [/owl|eule|kauz/i,                     { art: 'Eule',            emoji: '🦉', color: '#9a8262' }],
  [/gull|möwe|larus/i,                   { art: 'Möwe',            emoji: '🕊️', color: '#e8eef2' }],
  [/goose|gans|anser|duck|ente|eider|scoter|swan|schwan/i, { art: 'Wasservogel', emoji: '🦆', color: '#6fa8c7' }],
  [/crane|kranich|grus/i,                { art: 'Kranich',         emoji: '🐦', color: '#b9c2c7' }],
  [/bat|fledermaus/i,                    { art: 'Fledermaus',      emoji: '🦇', color: '#6b5b7b' }],
  [/wolf|wolves/i,                       { art: 'Wolf',            emoji: '🐺', color: '#8d8d8d' }],
  [/bear|bär|ursus/i,                    { art: 'Bär',             emoji: '🐻', color: '#7a5230' }],
  [/deer|hirsch|reh|elk|moose|caribou|reindeer/i, { art: 'Hirschartige', emoji: '🦌', color: '#a3763f' }],
  [/boar|wildschwein|sus scrofa/i,       { art: 'Wildschwein',     emoji: '🐗', color: '#6b5140' }],
  [/elephant|elefant/i,                  { art: 'Elefant',         emoji: '🐘', color: '#9a9a9a' }],
  [/lion|löwe|leopard|cheetah|panther/i, { art: 'Großkatze',       emoji: '🐆', color: '#d4a24c' }],
  [/zebra|wildebeest|gnu|antelope|gazelle|buffalo/i, { art: 'Huftier', emoji: '🦓', color: '#cfcfcf' }],
  [/turtle|schildkröte/i,                { art: 'Meeresschildkröte', emoji: '🐢', color: '#4f8f6a' }],
  [/shark|hai/i,                         { art: 'Hai',             emoji: '🦈', color: '#5f8ba6' }],
  [/whale|wal|dolphin|delfin|seal|robbe/i, { art: 'Meeressäuger',  emoji: '🐋', color: '#4a7fa5' }],
  [/fish|lachs|salmon|tuna|cod/i,        { art: 'Fisch',           emoji: '🐟', color: '#5aa0c0' }],
  [/fox|fuchs/i,                         { art: 'Fuchs',           emoji: '🦊', color: '#d1782f' }],
  [/bird|vogel|passerine|warbler|swift|swallow|pigeon|taube/i, { art: 'Vogel', emoji: '🐦', color: '#cfd8dc' }],
]
const speciesOf = (studyName) => (SPECIES.find(([re]) => re.test(studyName))?.[1])
  || { art: 'Wildtier', emoji: '🐾', color: '#9ccc9c' }

const jget = async (url) => {
  const r = await fetch(url, { headers: UA })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const t = await r.text()
  if (!t.trim().startsWith('{') && !t.trim().startsWith('[')) throw new Error('kein JSON (Lizenz-/Zugriffshinweis)')
  return JSON.parse(t)
}

/** Letzte Position je Individuum einer Studie. */
const fetchStudy = (id) =>
  jget(`${BASE}?study_id=${encodeURIComponent(id)}&sensor_type=gps&max_events_per_individual=1`)

// ─── Entdeckung: welche Studien liefern AKTUELLE Fixes? ────────────────────
let liveStudies = []      // [{ id, name, species }]
let lastDiscover = 0

async function discover(log) {
  const now = Date.now()
  let candidates
  if (FIXED_STUDIES.length) {
    candidates = FIXED_STUDIES.map(id => ({ id, name: `Studie ${id}` }))
    log(`feste Studien aus MB_STUDIES: ${candidates.length}`)
  } else {
    const all = await jget(`${BASE}?entity_type=study&i_can_see_data=true&there_are_data_available=true`)
    candidates = all
      .filter(s => s.suspend_license_terms && /gps/i.test(s.sensor_type_ids || ''))
      .map(s => ({ id: s.id, name: s.name || `Studie ${s.id}` }))
    log(`${all.length} öffentliche Studien · ${candidates.length} mit GPS + freier Lizenz — prüfe Aktualität …`)
  }

  const found = []
  for (const c of candidates) {
    if (found.length >= MAX_STUDIES) break
    try {
      const j = await fetchStudy(c.id)
      const fresh = (j.individuals || []).filter(i => {
        const t = (i.locations || [])[0]?.timestamp
        return Number.isFinite(t) && (now - t) < MAX_AGE_MS
      })
      if (fresh.length) {
        found.push({ ...c, species: speciesOf(c.name) })
        log(`  ✓ ${fresh.length.toString().padStart(3)} aktuelle Tiere · ${c.name.slice(0, 58)}`)
      }
    } catch { /* Studie nicht abrufbar → überspringen */ }
    await sleep(REQ_DELAY_MS)
  }
  liveStudies = found
  lastDiscover = Date.now()
  log(`Entdeckung fertig: ${found.length} Studie(n) mit Fixes jünger als ${(MAX_AGE_MS / 86400000).toFixed(0)} Tage`)
}

// ─── Bestand ───────────────────────────────────────────────────────────────
const animals = new Map()   // key "studyId/individual" → { objectId, name }

// ─── Sync ──────────────────────────────────────────────────────────────────
async function sync(log, warn) {
  if (!liveStudies.length) return
  const now = Date.now()
  const seen = new Set()
  let created = 0, updated = 0, failed = 0, skipped = 0

  for (const st of liveStudies) {
    let j
    try { j = await fetchStudy(st.id) }
    catch (err) { warn(`Studie ${st.id}: ${err?.message || err}`); await sleep(REQ_DELAY_MS); continue }

    for (const ind of (j.individuals || [])) {
      const loc = (ind.locations || [])[0]
      if (!loc || !Number.isFinite(loc.location_lat) || !Number.isFinite(loc.location_long)) continue
      const age = now - loc.timestamp
      if (!(age < MAX_AGE_MS)) continue
      if (animals.size >= MAX_ANIMALS && !animals.has(`${st.id}/${ind.individual_local_identifier}`)) { skipped++; continue }

      const key = `${st.id}/${ind.individual_local_identifier || ind.individual_id}`
      seen.add(key)
      const tier = String(ind.individual_local_identifier || ind.individual_id || '?').trim()
      const name = `${st.species.art} ${tier}`.slice(0, 32)
      const hours = age / 3600000
      const alter = hours < 1 ? `${Math.round(age / 60000)} min`
        : hours < 48 ? `${hours.toFixed(1)} h`
        : `${(hours / 24).toFixed(1)} Tage`
      const fields = {
        name,
        type: 'animal',
        description: `${st.species.art} „${tier}" · letzter GPS-Fix vor ${alter} · Studie: ${st.name} · Daten: Movebank (Tier-Telemetrie der Forschung)`,
        lat: loc.location_lat, lon: loc.location_long, altitude: 0,
        appearance: { emoji: st.species.emoji, color: st.species.color },
        state: {
          source: SOURCE, movebank_study: st.id, movebank_study_name: st.name,
          individual: tier, species: st.species.art,
          fix_ts: loc.timestamp, realtime: false,
        },
      }
      const known = animals.get(key)
      try {
        if (!known) {
          const obj = await ajna.createObject(fields)
          animals.set(key, { objectId: obj.id, name })
          created++
        } else {
          await ajna.updateObject(known.objectId, fields)
          known.name = name
          updated++
        }
      } catch (err) {
        failed++
        if (!known) animals.delete(key)
        warn(`${key}: ${err?.response?.data?.message || err?.message || err}`)
      }
    }
    await sleep(REQ_DELAY_MS)
  }

  // Tiere, deren Fix zu alt geworden ist (oder Studie weg) → entfernen.
  let removed = 0
  for (const [key, a] of animals) {
    if (seen.has(key)) continue
    try { await ajna.deleteObject(a.objectId); animals.delete(key); removed++ }
    catch (err) { warn(`delete ${key}: ${err?.message || err}`) }
  }
  log(`${animals.size} Tiere aus ${liveStudies.length} Studie(n) — ${created} neu, ${updated} aktualisiert${removed ? `, ${removed} entfernt` : ''}${skipped ? `, ${skipped} über Limit` : ''}${failed ? `, ${failed} Fehler` : ''}`)
}

// ─── Start ─────────────────────────────────────────────────────────────────
const { log, warn } = { log: (...a) => console.log('[movebank]', ...a), warn: (...a) => console.warn('[movebank]', ...a) }

await publishManifest(ajna, {
  source: SOURCE,
  agent_name: 'Wildtiere (Movebank)',
  description: 'GPS-besenderte Wildtiere aus öffentlichen Forschungsstudien (Movebank)',
  layers: [{ key: 'all', label: 'Alle Tiere', predicate: null }],
})

// Bestand adoptieren (idempotent über Studie/Individuum).
try {
  await ajna.refreshObjects()
  for (const o of ajna.getObjects()) {
    if (o?.state?.source !== SOURCE) continue
    animals.set(`${o.state.movebank_study}/${o.state.individual}`, { objectId: o.id, name: o.name })
  }
  if (animals.size) log(`${animals.size} vorhandene Tiere adoptiert`)
} catch (err) { warn(`Bestands-Listing: ${err?.message || err}`) }

log(`Entdeckungslauf startet (bis zu ${MAX_STUDIES} Live-Studien, ${REQ_DELAY_MS} ms Abstand) …`)
await discover(log)
await sync(log, warn)

setInterval(async () => {
  try {
    if (Date.now() - lastDiscover > DISCOVER_MS) await discover(log)
    await sync(log, warn)
  } catch (err) { warn(`Zyklus: ${err?.message || err}`) }
}, POLL_MS)

log(`bereit — Poll alle ${POLL_MS / 1000} s, Neu-Entdeckung alle ${DISCOVER_MS / 3600000} h. (Strg+C zum Beenden)`)
