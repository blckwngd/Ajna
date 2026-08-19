// Validation für Parley: Muster, Bedingungen, Zustand, Vererbung, Auswahlantworten.
// Run: node parley/test/parley.test.mjs
import { Parley, compilePattern, matchPattern, literalOf, normalize, tokenizePair, swapPerson, fillIn } from '../index.mjs'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failures++ }
}
const gleich = (a, b, msg) => assert(a === b, `${msg} (ist: ${JSON.stringify(a)})`)

// Deterministischer RNG — sonst wäre jede Antwortwahl ein Münzwurf.
const rngFactory = (seed = 12345) => () => {
  seed = (1103515245 * seed + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

// ── Normalisierung ───────────────────────────────────────────────────────
console.log('Normalisierung:')
gleich(normalize("Hallo, wie geht's?"), 'hallo wie geht s', 'Satzzeichen fallen weg')
gleich(normalize('Straße'), 'strasse', 'ß wird ss')
gleich(normalize('Schön'), 'schoen', 'Umlaut wird umschrieben')
gleich(normalize('Café'), 'cafe', 'Akzent fällt auf den Grundbuchstaben')
gleich(swapPerson('ich mag dich'), 'du magst mich', 'Personentausch')

// ── Muster ───────────────────────────────────────────────────────────────
console.log('\nMuster:')
const m = (pat, text, listen = {}) => {
  const { norm, roh } = tokenizePair(text)
  return matchPattern(compilePattern(pat, listen), norm, roh)
}
assert(m('hallo', 'Hallo!'), 'wörtlich')
assert(m('hallo *', 'hallo'), '* darf leer sein')
assert(m('* hallo *', 'sag mal hallo du'), '* umschließt')
assert(!m('hallo', 'hallo du'), 'ohne * kein Rest erlaubt')
assert(m('ich bin ?', 'ich bin jonas'), '? ist genau ein Wort')
assert(!m('ich bin ?', 'ich bin sehr müde'), '? nimmt nicht zwei Wörter')
assert(m('ich habe # jahre', 'ich habe 12 jahre'), '# ist eine Zahl')
assert(!m('ich habe # jahre', 'ich habe viele jahre'), '# ist keine Zahl-Attrappe')
assert(m('(guten tag|moin) *', 'guten tag zusammen'), 'Alternativen, mehrwortig')
assert(m('[na] moin', 'na moin') && m('[na] moin', 'moin'), '[…] darf fehlen')
assert(m('@gruss *', 'moin du', { gruss: ['hallo', 'moin'] }), '@liste')
gleich(m('ich heisse *', 'Ich heiße Ada')[0], 'Ada', 'Wildcard-Fund in Originalschreibweise')
gleich(m('ich heisse *', 'ICH HEISSE ada')[0], 'ada', 'verglichen wird trotzdem gefaltet')
gleich(m('* hallo *', 'Sag mal hallo du')[0], 'Sag mal', 'erstes * ist kürzest-zuerst')
gleich(literalOf(compilePattern('wer bist du')), 'wer bist du', 'wörtliches Muster als Vorschlag')
gleich(literalOf(compilePattern('wer bist *')), null, 'Wildcard liefert keinen Vorschlag')
gleich(literalOf(compilePattern('wink [mal]')), 'wink', 'Weglassbares fällt aus dem Vorschlag')

// ── Platzhalter ──────────────────────────────────────────────────────────
console.log('\nPlatzhalter:')
gleich(fillIn('Hallo {name}', { vars: { name: 'Mara' } }), 'Hallo Mara', '{var}')
gleich(fillIn('Du sagst: {swap:1}', { caps: ['ich bin müde'] }), 'Du sagst: du bist müde', '{swap:n}')
gleich(fillIn('{unbekannt}!', { vars: {} }), '!', 'unbekannte Variable wird leer')

// ── Regelwerk ────────────────────────────────────────────────────────────
console.log('\nRegeln, Zustand, Bedingungen:')
const basis = {
  name: 'basis',
  input: 'auto',
  vars: { name: 'Basis', laune: 0 },
  lists: { gruss: ['hallo', 'moin'] },
  rules: [
    { label: 'gruss', when: ['@gruss *'], if: { kennt: { set: false } }, then: 'Hallo, ich bin {name}.', set: { kennt: true } },
    { label: 'gruss2', when: ['@gruss *'], then: 'Schon wieder hallo.', suggest: false },
    { label: 'danke', when: ['danke *'], then: 'Gern.', set: { laune: { '+': 1 } } },
    { label: 'laune', when: ['wie ist deine laune'], then: 'Laune: {laune}' },
  ],
  fallback: [{ when: ['*'], then: 'Keine Ahnung.', suggest: false }],
}
const kind = {
  name: 'kind',
  extends: 'basis',
  vars: { name: 'Kind' },
  rules: [
    { label: 'spezial', when: ['* wetter *'], then: 'Schön heute.' },
    { label: 'einmal', when: ['geheimnis'], then: 'Nur einmal.', once: true },
    { label: 'nachher', after: 'spezial', when: ['echt'], then: 'Ganz sicher.' },
    { label: 'aktion', when: ['wink'], then: 'Bitte.', do: ['anim:wave', { action: 'goto', to: 'markt' }] },
  ],
  fallback: [{ when: ['?'], then: 'Ein Wort nur?', suggest: false }],
}

const p = new Parley([basis, kind], { rng: rngFactory() })
const c = p.open('kind', 's1', { vars: { name: 'Mara' } })

gleich(c.say('Moin!').text, 'Hallo, ich bin Mara.', 'geerbte Regel + Variable des Aufrufers')
gleich(c.say('moin').text, 'Schon wieder hallo.', 'Bedingung schaltet auf die zweite Regel um')
gleich(c.say('Wie ist das Wetter?').text, 'Schön heute.', 'eigene Regel schlägt geerbte')
gleich(c.say('echt').text, 'Ganz sicher.', 'after greift direkt danach')
gleich(c.say('echt').label, null, 'after greift NICHT zweimal (Fallback übernimmt)')
gleich(c.say('danke schön').text, 'Gern.', 'geerbte Regel mit Zähler')
gleich(c.say('wie ist deine laune').text, 'Laune: 1', 'set {+:1} hat gezählt')
gleich(c.say('geheimnis').text, 'Nur einmal.', 'once beim ersten Mal')
gleich(c.say('geheimnis').label, null, 'once nicht beim zweiten Mal')
gleich(c.say('kartoffel').text, 'Ein Wort nur?', 'eigener Fallback vor geerbtem')
gleich(c.say('irgendwas mit mehreren wörtern').text, 'Keine Ahnung.', 'geerbter Fallback')

const akt = c.say('wink')
gleich(JSON.stringify(akt.do), JSON.stringify([{ action: 'anim', value: 'wave' }, { action: 'goto', to: 'markt' }]), 'do-Aktionen in einheitlicher Form')

// ── Auswahlantworten ─────────────────────────────────────────────────────
console.log('\nAuswahlantworten:')
const a = p.open('kind', 's2')
const r1 = a.say('moin')
assert(Array.isArray(r1.choices) && r1.choices.length > 0, 'input:auto leitet Vorschläge ab')
assert(r1.choices.every(x => x.label && x.send), 'Vorschläge haben Beschriftung und Sendetext')
assert(!r1.choices.some(x => /wetter/.test(x.send)), 'Wildcard-Muster liefert keinen Vorschlag')
const r2 = a.say('Wie ist das Wetter?')
gleich(r2.choices[0].send, 'echt', 'Anschlussregel (after) steht vorn')

const explizit = new Parley({
  name: 'x', rules: [{ when: ['*'], then: 'Wähle:', choices: [{ label: 'Ja klar', send: 'ja' }, 'nein'], input: 'choice' }],
})
const rx = explizit.open('x', 's').say('egal')
gleich(rx.input, 'choice', 'input:choice wird durchgereicht')
gleich(rx.choices.length, 2, 'explizite Auswahl')
gleich(rx.choices[1].send, 'nein', 'String-Kurzform in choices')

// ── Sitzungen ────────────────────────────────────────────────────────────
console.log('\nSitzungen:')
assert(p.session('s1') === c, 'Sitzung wiederfinden')
const json = c.toJSON()
const wieder = p.open('kind', 's3', { restore: json })
gleich(wieder.vars.laune, 1, 'Zustand aus JSON wiederhergestellt')
gleich(wieder.hits.einmal, 1, 'Trefferzähler überlebt das Sichern')
wieder.reset()
gleich(wieder.vars.name, 'Kind', 'reset stellt die Dokument-Variablen her')
p.close('s3')
assert(p.session('s3') === null, 'close entfernt die Sitzung')

// ── Fehlerfälle ──────────────────────────────────────────────────────────
console.log('\nFehler:')
const wirft = (fn, was) => { try { fn(); assert(false, was) } catch { assert(true, was) } }
wirft(() => new Parley({ rules: [] }), 'Dokument ohne Namen wird abgelehnt')
wirft(() => new Parley({ name: 'z', rules: [{ when: ['@fehlt'], then: 'x' }] }).chain('z'), 'unbekannte Liste wird abgelehnt')
wirft(() => new Parley({ name: 'z', rules: [{ when: ['x'] }] }), 'Regel ohne then/do/set wird abgelehnt')
wirft(() => new Parley({ name: 'z', rules: [{ when: ['(a'], then: 'x' }] }).chain('z'), 'unvollständige Klammer wird abgelehnt')
wirft(() => new Parley({ name: 'z', rules: [] }).open('gibtesnicht', 's'), 'unbekannter Dialogsatz wird abgelehnt')

console.log(failures === 0 ? '\nAll Parley tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
