// Tests für agents/lib/figuren.mjs — der Katalog fest entworfener Figuren.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruefeFigur, alsObjekt, unterschied, ladeFiguren,
         alsAuftragsObjekt, auftragsUnterschied, auftragsBody,
         alsBelohnungsObjekt } from './figuren.mjs'

const ROH = {
  id: 'marktfrau-neuwied',
  name: 'Marktfrau Agnes',
  type: 'npc',
  lat: 50.4297, lon: 7.4608,
  description: 'Steht seit dreissig Jahren am selben Platz.',
  dialog: 'marktfrau',
  dialog_vars: { ware: 'Äpfel' },
  appearance: { emoji: '🧺', gltf: 'Soldier.glb' },
}

test('eine vollständige Figur kommt durch', () => {
  const { figur, fehler } = pruefeFigur(ROH, 'a.figur.json')
  assert.equal(fehler, undefined)
  assert.equal(figur.id, 'marktfrau-neuwied')
  assert.equal(figur.type, 'npc')
  assert.equal(figur.movement, 'still')      // Vorgabe
})

test('ohne Kennung keine Figur', () => {
  // Ohne `id` erkennt der Director sie beim nächsten Start nicht wieder und
  // legt sie ein zweites Mal an — eine halbe Figur ist schlimmer als keine.
  assert.match(pruefeFigur({ ...ROH, id: '' }, 'x').fehler, /"id" fehlt/)
  assert.match(pruefeFigur({ ...ROH, id: 'mit leerzeichen' }, 'x').fehler, /nur Buchstaben/)
})

test('ohne brauchbaren Ort keine Figur', () => {
  assert.match(pruefeFigur({ ...ROH, lat: undefined }, 'x').fehler, /"lat"/)
  assert.match(pruefeFigur({ ...ROH, lon: 999 }, 'x').fehler, /"lon"/)
  // 0/0 ist ein gültiger Ort (Golf von Guinea) — nicht versehentlich verwerfen.
  assert.equal(pruefeFigur({ ...ROH, lat: 0, lon: 0 }, 'x').fehler, undefined)
})

test('ein unbekannter Typ wird abgelehnt, nicht stillschweigend ersetzt', () => {
  assert.match(pruefeFigur({ ...ROH, type: 'drache-xl' }, 'x').fehler, /erlaubt:/)
})

test('lange Namen werden gekürzt — objects.name fasst 32 Zeichen', () => {
  const { figur } = pruefeFigur({ ...ROH, name: 'A'.repeat(50) }, 'x')
  assert.equal(figur.name.length, 32)
  assert.ok(figur.name.endsWith('…'))
})

test('alsObjekt setzt den Merker, auf den es ankommt', () => {
  const { figur } = pruefeFigur(ROH, 'x')
  const o = alsObjekt(figur)
  assert.equal(o.state.persistent, true)   // überlebt das Verlassen der Gegend
  assert.equal(o.state.figure_id, 'marktfrau-neuwied')
  assert.equal(o.state.source, 'world-director')
  assert.equal(o.state.director, true)     // damit die Profil-Heilung sie kennt
  assert.equal(o.state.dialog_set, 'marktfrau')
  assert.deepEqual(o.state.dialog_vars, { ware: 'Äpfel' })
  assert.equal(o.state.movement, 'still')
})

test('Modellnamen bekommen den Pfad vorangestellt, URLs nicht', () => {
  const { figur } = pruefeFigur(ROH, 'x')
  assert.equal(alsObjekt(figur, '/models/').appearance.gltf, '/models/Soldier.glb')
  const { figur: f2 } = pruefeFigur({ ...ROH, appearance: { gltf: 'https://x.de/a.glb' } }, 'x')
  assert.equal(alsObjekt(f2, '/models/').appearance.gltf, 'https://x.de/a.glb')
})

test('ohne Dialog steht kein leeres dialog_set im state', () => {
  const { figur } = pruefeFigur({ ...ROH, dialog: '', dialog_vars: {} }, 'x')
  const o = alsObjekt(figur)
  assert.ok(!('dialog_set' in o.state))
  assert.ok(!('dialog_vars' in o.state))
})

test('unterschied erkennt eine verschobene Figur', () => {
  const { figur } = pruefeFigur(ROH, 'x')
  const bestand = { ...alsObjekt(figur), lat: 50.1 }
  const p = unterschied(figur, bestand)
  assert.equal(p.lat, 50.4297)
  assert.ok(!('lon' in p), 'nur das Geänderte')
})

test('unterschied lässt den Betriebs-Zustand in Ruhe', () => {
  // `motion` und `hp` gehören dem laufenden Betrieb, nicht der Datei. Sie bei
  // jedem Start zurückzusetzen hiesse, jede Figur wieder zu heilen und an den
  // Anfang ihres Weges zu stellen.
  const { figur } = pruefeFigur(ROH, 'x')
  const o = alsObjekt(figur)
  const bestand = { ...o, name: 'Alt', state: { ...o.state, motion: { v: 3 }, hp: 4 } }
  const p = unterschied(figur, bestand)
  assert.equal(p.name, 'Marktfrau Agnes')
  assert.ok(!p.state, 'state unverändert → kein Patch darauf')
})

test('unterschied meldet null, wenn alles passt', () => {
  const { figur } = pruefeFigur(ROH, 'x')
  assert.equal(unterschied(figur, alsObjekt(figur)), null)
})

test('ein fehlender Ordner ist kein Fehler', () => {
  const { figuren, fehler } = ladeFiguren('/gibt/es/nicht')
  assert.deepEqual(figuren, [])
  assert.deepEqual(fehler, [])
})

test('unterschied stolpert nicht über die Schlüsselreihenfolge', () => {
  // PocketBase gibt `{color, emoji}` zurück, wo wir `{emoji, color}` geschickt
  // haben. Ein Vergleich über JSON.stringify meldete dadurch bei JEDEM Start
  // „geändert" und schrieb dieselben Werte erneut — samt Realtime-Nachricht an
  // alle verbundenen Clients.
  const { figur } = pruefeFigur(ROH, 'x')
  const o = alsObjekt(figur)
  const gedreht = {
    ...o,
    appearance: Object.fromEntries(Object.entries(o.appearance).reverse()),
    state: Object.fromEntries(Object.entries(o.state).reverse()),
  }
  assert.equal(unterschied(figur, gedreht), null)
})

test('persistent ist gesetzt, on_demand ausdrücklich NICHT', () => {
  // Der Unterschied trägt die Bevölkerungsregel: `persistent` zählt zur
  // Soll-Dichte (eine entworfene Gestalt ersetzt eine zufällige),
  // `on_demand` nicht (vom Spieler gesetzte Objekte sind Zugabe).
  const { figur } = pruefeFigur(ROH, 'x')
  const o = alsObjekt(figur)
  assert.equal(o.state.persistent, true)
  assert.ok(!('on_demand' in o.state))
})

// ─── Aufträge ─────────────────────────────────────────────────────────────

const MIT_AUFTRAG = {
  ...ROH,
  quest: {
    text: 'Sieh nach der alten Linde und melde, wie es ihr geht.',
    place: 'Am Kirchplatz',
    proof: ['photo', 'onSite'],
    review: 'issuer',
    karma: 5,
    reward: { name: 'Lindenblatt', count: 3, emoji: '🍃' },
  },
}

test('ein Auftrag ohne Belohnung wird abgelehnt, nicht stillschweigend geschluckt', () => {
  // Der Server lehnt eine Ausschreibung ohne hinterlegte Gegenstände ab
  // („rewards are never minted"). Ohne diese Prüfung fiele das erst beim
  // Veröffentlichen auf — mit einem englischen 400 im Agentenlog.
  const { fehler } = pruefeFigur({ ...MIT_AUFTRAG, quest: { text: 'Tu was' } }, 'x')
  assert.match(fehler, /reward\.name/)
})

test('unbekannte Nachweisart und unbekannter Abnahmeweg fliegen auf', () => {
  const a = { ...MIT_AUFTRAG.quest, proof: ['selfie'] }
  assert.match(pruefeFigur({ ...MIT_AUFTRAG, quest: a }, 'x').fehler, /Nachweisart/)
  const b = { ...MIT_AUFTRAG.quest, review: 'vertrauen' }
  assert.match(pruefeFigur({ ...MIT_AUFTRAG, quest: b }, 'x').fehler, /review/)
})

test('eine Figur ohne Auftrag trägt auch keinen leeren', () => {
  const { figur } = pruefeFigur(ROH, 'x')
  assert.ok(!('quest' in figur))
  assert.equal(alsAuftragsObjekt(figur), null)
  assert.equal(alsBelohnungsObjekt(figur), null)
})

test('der Auftrag wird ein eigenes call-Objekt am Ort der Figur', () => {
  // Ein Auftrag IST in Ajna ein Objekt vom Typ `call` — die Routen prüfen das.
  // Die Bindung an die Figur ist `state.figure_quest`.
  const { figur } = pruefeFigur(MIT_AUFTRAG, 'x')
  const o = alsAuftragsObjekt(figur)
  assert.equal(o.type, 'call')
  assert.equal(o.state.figure_quest, 'marktfrau-neuwied')
  assert.equal(o.state.persistent, true)
  assert.ok(!('director' in o.state), 'kein Director-Objekt — sonst zählt es zur Bevölkerung')
  assert.equal(o.lat, ROH.lat)
  assert.equal(o.state.call.task, MIT_AUFTRAG.quest.text)
  assert.equal(o.state.call.karma, 5)
  assert.equal(o.state.call.onSiteRadiusM, 150)   // Vorgabe
  assert.equal(o.state.call.listed, true)         // „sofort" ist die Vorgabe
})

test('Melde-Nähe steht nur da, wo der Nachweis sie verlangt', () => {
  const a = { ...MIT_AUFTRAG.quest, proof: ['photo'] }
  const { figur } = pruefeFigur({ ...MIT_AUFTRAG, quest: a }, 'x')
  assert.ok(!('onSiteRadiusM' in alsAuftragsObjekt(figur).state.call))
})

test('„nur bei der Figur" und „nach Wartezeit" landen im Zustand', () => {
  const nie = pruefeFigur({ ...MIT_AUFTRAG, quest: { ...MIT_AUFTRAG.quest, listAfter: 'nie' } }, 'x').figur
  assert.equal(alsAuftragsObjekt(nie).state.call.listed, false)
  assert.ok(!('listAfterHours' in alsAuftragsObjekt(nie).state.call))

  const spaeter = pruefeFigur({ ...MIT_AUFTRAG, quest: { ...MIT_AUFTRAG.quest, listAfter: 24 } }, 'x').figur
  assert.equal(alsAuftragsObjekt(spaeter).state.call.listed, false)
  assert.equal(alsAuftragsObjekt(spaeter).state.call.listAfterHours, 24)
})

test('Wiederholbarkeit gehört in den Rumpf der Ausschreibung, nicht in den Zustand', () => {
  // Der Server prüft dort, ob der Vorrat für die Durchläufe reicht. Ein Client,
  // der das selbst in `state.call` schriebe, ginge an der Prüfung vorbei.
  const a = { ...MIT_AUFTRAG.quest, repeatable: true, reward: { name: 'Blatt', count: 4, perRun: 2 } }
  const { figur } = pruefeFigur({ ...MIT_AUFTRAG, quest: a }, 'x')
  const body = auftragsBody(figur, ['a', 'b', 'c', 'd'])
  assert.equal(body.repeatable, true)
  assert.equal(body.rewardPerRun, 2)
  assert.equal(body.verify, 'issuer')
  assert.deepEqual(body.rewardItems, ['a', 'b', 'c', 'd'])
  // Mehr je Durchlauf als hinterlegt lehnt der Server ab — deshalb gedeckelt.
  const zuviel = { ...a, reward: { name: 'Blatt', count: 2, perRun: 9 } }
  assert.equal(pruefeFigur({ ...MIT_AUFTRAG, quest: zuviel }, 'x').figur.quest.perRun, 2)
})

test('auftragsUnterschied lässt den Lebenszyklus in Ruhe', () => {
  // Veröffentlichen setzt `status` und `claimedBy` zurück. Wer einen Tippfehler
  // im Auftragstext behebt, darf dem Spieler, der gerade unterwegs ist, den
  // Auftrag nicht unter den Füßen wegziehen.
  const { figur } = pruefeFigur(MIT_AUFTRAG, 'x')
  const o = alsAuftragsObjekt(figur)
  const bestand = {
    ...o,
    state: { ...o.state, call: { ...o.state.call, task: 'Alter Text',
      status: 'claimed', claimedBy: 'spieler1', rewardItems: ['x1'], publishedAt: '2026-01-01' } },
  }
  const patch = auftragsUnterschied(figur, bestand)
  assert.equal(patch.state.call.task, MIT_AUFTRAG.quest.text)
  assert.equal(patch.state.call.status, 'claimed')
  assert.equal(patch.state.call.claimedBy, 'spieler1')
  assert.deepEqual(patch.state.call.rewardItems, ['x1'])
})

test('auftragsUnterschied räumt weg, was die Datei nicht mehr fordert', () => {
  const a = { ...MIT_AUFTRAG.quest, proof: ['photo'], acceptRadiusM: 0 }
  const { figur } = pruefeFigur({ ...MIT_AUFTRAG, quest: a }, 'x')
  const o = alsAuftragsObjekt(figur)
  const bestand = { ...o, state: { ...o.state, call: { ...o.state.call, onSiteRadiusM: 150, acceptRadiusM: 40 } } }
  const patch = auftragsUnterschied(figur, bestand)
  assert.ok(!('onSiteRadiusM' in patch.state.call))
  assert.ok(!('acceptRadiusM' in patch.state.call))
})

test('auftragsUnterschied meldet null, wenn alles passt', () => {
  const { figur } = pruefeFigur(MIT_AUFTRAG, 'x')
  assert.equal(auftragsUnterschied(figur, alsAuftragsObjekt(figur)), null)
})

test('Belohnungen sind eigene, tragbare Objekte mit Herkunftsmarke', () => {
  // An der Marke findet der Director beim nächsten Start wieder, was er schon
  // angelegt hat — sonst entstünde bei jedem Lauf ein weiterer Stapel.
  const { figur } = pruefeFigur(MIT_AUFTRAG, 'x')
  const item = alsBelohnungsObjekt(figur, 2)
  assert.equal(item.type, 'item')
  assert.equal(item.name, 'Lindenblatt')
  assert.equal(item.state.portable, true)
  assert.equal(item.state.figure_reward, 'marktfrau-neuwied#2')
})
