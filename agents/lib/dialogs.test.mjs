// Validation für die mitgelieferten Dialogsätze (/dialogs) und ihre Anbindung.
// Prüft nicht den Wortlaut — der darf sich ändern —, sondern dass jede Regel
// erreichbar ist, die Vererbung greift und keine Figur ins Leere läuft.
// Run: node agents/lib/dialogs.test.mjs
import { npcParley, loadDialogSets } from './dialogs.mjs'
import { dialogNameFor, dialogVarsFor, talkSessionId, objectDialog, STANDARD_DIALOGS } from '../../client/core/Parley.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failures++ }
}
const gleich = (a, b, msg) => assert(a === b, `${msg} (ist: ${JSON.stringify(a)})`)

const rng = (() => { let s = 4711; return () => (s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff })()

// ── Laden ────────────────────────────────────────────────────────────────
console.log('Dialogsätze laden:')
const docs = loadDialogSets()
gleich(docs.length, STANDARD_DIALOGS.length, `${STANDARD_DIALOGS.length} Sätze gefunden`)
for (const n of STANDARD_DIALOGS) assert(docs.some(d => d.name === n), `"${n}" ist dabei`)

const parley = npcParley({ rng })
for (const n of STANDARD_DIALOGS) {
  try { parley.chain(n); assert(true, `"${n}" kompiliert`) }
  catch (err) { assert(false, `"${n}" kompiliert — ${err.message}`) }
}

// ── Zuordnung Objekt → Dialogsatz ────────────────────────────────────────
console.log('\nZuordnung:')
const objekt = (archetype, name) => ({ id: 'obj1', name, type: archetype, state: { archetype } })
gleich(dialogNameFor(objekt('npc', 'Mara Berger')), 'mensch', 'npc → mensch')
gleich(dialogNameFor(objekt('enemy', 'Nebelbeisser')), 'gestalt', 'enemy → gestalt')
gleich(dialogNameFor(objekt('animal', 'Fuchs')), 'tier', 'animal → tier')
gleich(dialogNameFor(objekt('dragon', 'Vyrthax')), 'drache', 'dragon → drache')
gleich(dialogNameFor({ state: { archetype: 'npc', dialog_set: 'eigen' } }), 'eigen', 'state.dialog_set gewinnt')
gleich(dialogNameFor({ state: {} }), 'basis', 'unbekannter Typ fällt auf basis')
gleich(dialogVarsFor(objekt('npc', 'Mara Berger')).name, 'Mara Berger', 'Figurenname als Variable')
gleich(talkSessionId('u1', 'o1'), 'u1@o1', 'Sitzungsschlüssel')

// ── Ein Gespräch mit einem Menschen ──────────────────────────────────────
console.log('\nGespräch (mensch):')
const mara = objekt('npc', 'Mara Berger')
const chat = parley.open(dialogNameFor(mara), talkSessionId('u1', mara.id), { vars: dialogVarsFor(mara) })

const sag = (text) => chat.say(text)
const trifft = (text, label, was) => {
  const r = sag(text)
  assert(r.label === label, `${was}: "${text}" → ${label} (ist: ${r.label})`)
  return r
}

const hallo = trifft('Hallo!', 'gruss', 'Begrüßung')
assert(hallo.text.includes('Mara Berger'), 'Antwort nennt den Figurennamen')
assert(Array.isArray(hallo.choices) && hallo.choices.length > 0, 'Begrüßung bietet Anschlussfragen an')
trifft('hallo', 'gruss_wieder', 'zweite Begrüßung fällt anders aus')
trifft('Wer bist du?', 'name', 'Namensfrage')
trifft('Ich heiße Jonas', 'spieler_name', 'Vorstellung')
gleich(chat.vars.spieler, 'Jonas', 'Spielername in Originalschreibweise gemerkt')
assert(sag('Wie heiße ich?').text.includes('Jonas'), 'Figur erinnert sich an den Namen')
trifft('Ich bin müde', 'stimmung', 'Stimmung geht nicht als Vorstellung durch')
trifft('Was gibt es hier?', 'gegend', 'eigene Regel (mensch) vor geerbter')
trifft('Gibt es Neues?', 'geruecht', 'Gerücht')
trifft('Echt?', 'geruecht_nach', 'Anschlussregel nach dem Gerücht')
trifft('Wie ist das Wetter?', 'wetter', 'geerbte Regel aus basis')
const wink = trifft('wink mal', 'winken', 'Aktion')
gleich(JSON.stringify(wink.do), JSON.stringify([{ action: 'anim', value: 'wave' }]), 'Aktion wird geliefert')
trifft('Du bist nett.', 'nett', 'Kompliment')
trifft('du bist doof', 'grob', 'Grobheit wird freundlich abgefangen')
trifft('Tschüss!', 'tschuess', 'Verabschiedung')

// Vertraulich wird erst nach genug Gerede erreichbar.
console.log('\nZustand über mehrere Züge:')
const chat2 = parley.open('mensch', 's-vertraulich', { vars: { name: 'Tom Falk' } })
chat2.say('was gibt es hier')
chat2.say('gibt es neues')
chat2.say('was gibt es hier')
gleich(chat2.say('was ist hier los').label, 'vertraulich', 'nach drei Themen wird die Figur vertraulich')
gleich(chat2.say('was ist hier los').label, 'gegend', 'und danach wieder normal (once)')

// ── Tiere reden nicht wie Menschen ───────────────────────────────────────
console.log('\nGespräch (tier):')
const fuchs = objekt('animal', 'Fuchs')
const tier = parley.open(dialogNameFor(fuchs), talkSessionId('u1', 'o-fuchs'), { vars: dialogVarsFor(fuchs) })
assert(typeof tier.say('Guten Tag!').text === 'string', 'Tier antwortet überhaupt')
gleich(tier.say('Wie spät ist es?').label, null, 'Tier erbt NICHT die Uhrzeit-Regel aus basis')
gleich(tier.say('darf ich dich streicheln').label, 'streicheln_zu_frueh', 'Streicheln zunächst abgelehnt')
tier.say('hast du hunger')
tier.say('hier hast du was')
gleich(tier.say('darf ich dich streicheln').label, 'streicheln', 'nach Fütterung zutraulich')

// ── Gestalt und Drache ───────────────────────────────────────────────────
console.log('\nGespräch (gestalt, drache):')
const g = parley.open('gestalt', 's-g', { vars: { name: 'Nebelbeisser' } })
gleich(g.say('hallo').label, 'gruss', 'Gestalt grüßt (eigene Regel)')
gleich(g.say('bist du gefährlich').label, 'gefaehrlich', 'Gestalt zur Gefahr')
for (let i = 0; i < 4; i++) g.say('was machst du')
assert(g.say('und sonst so').label === 'aufgetaut' || g.hits.aufgetaut === 1, 'Gestalt taut nach genug Nachfragen auf')

const d = parley.open('drache', 's-d', { vars: { name: 'Vyrthax' } })
assert(d.say('Wer bist du?').text.includes('Vyrthax'), 'Drache nennt seinen Namen')
gleich(d.say('kannst du fliegen').label, 'fliegen', 'Drache zum Fliegen')
gleich(d.say('hast du einen schatz').label, 'schatz', 'Drache zum Hort')
gleich(d.say('wie alt bist du').label, 'alter', 'Drache zum Alter')
gleich(d.say('danke').label, 'vertrauen', 'nach genug Ehrfurcht wird der Drache zutraulich')

// ── Nichts läuft ins Leere ───────────────────────────────────────────────
console.log('\nKeine Sackgassen:')
for (const satz of STANDARD_DIALOGS) {
  const c = parley.open(satz, `s-leer-${satz}`, { vars: { name: 'Test' } })
  const r = c.say('kalkulierter unsinn über brückenpfeiler')
  assert(typeof r.text === 'string' && r.text.length > 0, `"${satz}" antwortet auch auf Unsinn`)
}

// ── Objekt-eigener Dialog ────────────────────────────────────────────────
console.log('\nObjekt-eigener Dialog (state.parley):')
const eigen = objectDialog({
  id: 'o9',
  state: { parley: { name: 'schild', rules: [{ when: ['lies *'], then: 'Hier stand mal etwas.' }] } },
})
assert(eigen && eigen.rules.length === 1, 'Dokument aus state.parley gelesen')
gleich(parley.add(eigen).name, 'schild', 'lässt sich in die Maschine aufnehmen')
gleich(parley.open('schild', 's-o9').say('lies das schild').text, 'Hier stand mal etwas.', 'und antwortet')

const boese = objectDialog({
  id: 'o10',
  state: { parley: { name: 'boese', rules: [{ when: ['* * * * * * * * * *'], then: 'x' }] } },
})
gleich(boese.rules[0].when.length, 0, 'Muster mit zu vielen Wildcards werden verworfen')
gleich(objectDialog({ state: { parley: 'kein objekt' } }), null, 'Unsinn in state.parley wird ignoriert')

console.log(failures === 0 ? '\nAll dialog tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
