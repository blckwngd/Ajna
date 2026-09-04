// Konfig — Einstellungen zur Laufzeit.
//
// WORUM ES HIER GEHT: Der Bau hat zwei Entscheidungen, die man beim Lesen des
// Codes für Kleinigkeiten halten könnte, und die beide etwas kaputtmachen,
// wenn sie kippen.
//
//   1. EIN LEERER DATENSATZ IST KEIN WERT. Der Agent legt seine Regler beim
//      Start als leere Formularfelder an. Würde ein leeres Feld als „null"
//      durchschlagen, zöge es beim ersten Start jede .env auf null — die Welt
//      stünde still, und in der Verwaltung sähe alles unauffällig aus.
//
//   2. EIGENTUM TRENNT. Ein Agent liest und schreibt nur SEINE Einstellungen.
//      Zwei World-Directors am selben Server dürfen sich nicht überschreiben.
//
// Dazu die alte Zusage aus `settings`: Geheimnisse kommen nie aus der Datenbank.

import { Konfig } from './konfig.mjs'

let failures = 0
const t = {
  check(msg, cond, info = '') {
    if (cond) console.log(`  ✓ ${msg}${info ? ` (${info})` : ''}`)
    else { console.error(`  ✗ ${msg}${info ? ` (${info})` : ''}`); failures++ }
  },
}

/** PocketBase-Attrappe: merkt sich Aufrufe, erlaubt Ereignisse von außen. */
function fakeAjna({ daten = {}, ich = 'konto-a' } = {}) {
  const rufe = []
  const abos = {}
  const pb = {
    authStore: { record: ich ? { id: ich } : null },
    collection(name) {
      return {
        async getFullList(opt) {
          rufe.push({ op: 'list', name, filter: opt?.filter || null })
          const alle = daten[name] || []
          // Die echte Collection filtert per Regel; die Attrappe tut so, als
          // hielte sie sich daran.
          if (!opt?.filter) return alle
          return alle.filter(r => opt.filter.includes(String(r.owner)))
        },
        async subscribe(topic, cb) { abos[name] = cb; return async () => { delete abos[name] } },
        async create(data) {
          rufe.push({ op: 'create', name, data })
          if ((daten[name] || []).some(r => r.key === data.key && r.owner === data.owner)) {
            throw new Error('unique constraint')
          }
          ;(daten[name] = daten[name] || []).push({ ...data })
          return data
        },
      }
    },
  }
  return { ajna: { pb }, rufe, abos, daten }
}

const still = () => {}

async function run() {
  console.log('Konfig')

  // ── Rangfolge: Datenbank → Env → Vorgabe ────────────────────────────────
  {
    const { ajna } = fakeAjna({
      daten: { agent_settings: [{ key: 'wd.count.enemy', value: 7, owner: 'konto-a' }] },
    })
    process.env.WD_COUNT_ENEMY = '4'
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('Datenbank schlägt Env', k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 7)

    delete process.env.WD_COUNT_ENEMY
    const { ajna: a2 } = fakeAjna()
    process.env.WD_COUNT_NPC = '4'
    const k2 = await Konfig.eigene(a2, { praefix: 'wd', log: still })
    t.check('Env schlägt Vorgabe', k2.ganz('count.npc', 'WD_COUNT_NPC', 3) === 4)
    delete process.env.WD_COUNT_NPC
    t.check('ohne beides gilt die Vorgabe', k2.ganz('count.npc', 'WD_COUNT_NPC', 3) === 3)
  }

  // ── Der Kern: ein leeres Feld ist KEIN Wert ─────────────────────────────
  {
    const { ajna } = fakeAjna({
      daten: {
        agent_settings: [
          { key: 'wd.count.enemy', value: null, owner: 'konto-a' },
          { key: 'wd.speed',       value: '',   owner: 'konto-a' },
        ],
      },
    })
    process.env.WD_COUNT_ENEMY = '4'
    process.env.WD_SPEED = '2.5'
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('leerer Datensatz zieht die Env nicht auf null',
      k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 4)
    t.check('leerer Text ebenso', k.zahl('speed', 'WD_SPEED', 1) === 2.5)
    delete process.env.WD_COUNT_ENEMY
    delete process.env.WD_SPEED
    t.check('und fällt dann auf die Vorgabe, nicht auf null',
      k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 3)
  }

  // ── Anlegen der Formularfelder ──────────────────────────────────────────
  {
    const { ajna, rufe, daten } = fakeAjna({
      daten: { agent_settings: [{ key: 'wd.count.enemy', value: 9, owner: 'konto-a' }] },
    })
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    const neu = await k.saee([
      { name: 'count.enemy', envName: 'WD_COUNT_ENEMY', vorgabe: 3, note: 'Gegner' },
      { name: 'count.npc',   envName: 'WD_COUNT_NPC',   vorgabe: 5, note: 'Figuren' },
    ])
    t.check('nur Fehlendes wird angelegt', neu === 1, `${neu} neu`)
    t.check('der vorhandene Wert bleibt unangetastet', k.ganz('count.enemy', null, 0) === 9)

    const angelegt = rufe.find(r => r.op === 'create')
    t.check('angelegt wird leer, nicht mit dem Env-Wert', angelegt?.data.value === null)
    t.check('mit Eigentümer', angelegt?.data.owner === 'konto-a')
    t.check('die Vorgabe steht in der Notiz', /Vorgabe: 5/.test(angelegt?.data.note || ''),
      angelegt?.data.note)
    t.check('und der Env-Name auch', /WD_COUNT_NPC/.test(angelegt?.data.note || ''))
    t.check('geschrieben wird in agent_settings', angelegt?.name === 'agent_settings')

    // Zweiter Lauf desselben Prozesses darf nichts mehr anlegen.
    const nochmal = await k.saee([{ name: 'count.npc', vorgabe: 5 }])
    t.check('ein zweiter Anlauf legt nichts doppelt an', nochmal === 0)
    t.check('und hinterlässt keinen zweiten Datensatz',
      daten.agent_settings.filter(r => r.key === 'wd.count.npc').length === 1)
  }

  // ── Geheimnisse ─────────────────────────────────────────────────────────
  {
    const { ajna, rufe } = fakeAjna({
      daten: { agent_settings: [{ key: 'wd.api_key', value: 'aus-der-datenbank', owner: 'konto-a' }] },
    })
    process.env.WD_API_KEY = 'aus-der-env'
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('ein Geheimnis kommt immer aus der Env, nie aus der Datenbank',
      k.text('api_key', 'WD_API_KEY', '') === 'aus-der-env')
    t.check('auch ohne Env-Namen bleibt der Datenbank-Wert liegen',
      k.text('api_key', null, 'vorgabe') === 'vorgabe')
    await k.saee([{ name: 'zugang', envName: 'WD_API_TOKEN', vorgabe: 'x' },
                  { name: 'secret.wort', vorgabe: 'y' }])
    t.check('und wird gar nicht erst als Feld angeboten',
      !rufe.some(r => r.op === 'create' && /zugang|secret/.test(r.data.key)))
    delete process.env.WD_API_KEY
  }

  // ── Eigentum trennt ─────────────────────────────────────────────────────
  {
    const { ajna, rufe } = fakeAjna({
      daten: {
        agent_settings: [
          { key: 'wd.count.enemy', value: 7,  owner: 'konto-a' },
          { key: 'wd.count.enemy', value: 99, owner: 'konto-b' },
        ],
      },
    })
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('gelesen wird mit Eigentümer-Filter', /konto-a/.test(rufe[0]?.filter || ''))
    t.check('der fremde Wert kommt nicht an', k.ganz('count.enemy', null, 0) === 7)
  }

  // ── Instanz-Bereich ─────────────────────────────────────────────────────
  {
    const { ajna, rufe } = fakeAjna({
      daten: { settings: [{ key: 'proof.maxagedays', value: 30 }] },
    })
    const k = await Konfig.instanz(ajna, { praefix: 'proof', log: still })
    t.check('die Instanz-Einstellungen liegen in settings', rufe[0]?.name === 'settings')
    t.check('und werden nicht nach Eigentümer gefiltert', rufe[0]?.filter === null)
    t.check('gelesen wird trotzdem gleich', k.ganz('maxagedays', null, 0) === 30)
    const neu = await k.saee([{ name: 'irgendwas', vorgabe: 1 }])
    t.check('ein Agent legt dort nichts an', neu === 0 && !rufe.some(r => r.op === 'create'))
  }

  // ── Änderungen zur Laufzeit ─────────────────────────────────────────────
  {
    const { ajna, abos } = fakeAjna({
      daten: { agent_settings: [{ key: 'wd.count.enemy', value: 3, owner: 'konto-a' }] },
    })
    let gerufen = 0
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    k.beiAenderung(() => { gerufen++ })

    abos.agent_settings({ action: 'update', record: { key: 'wd.count.enemy', value: 12, owner: 'konto-a' } })
    t.check('eine Änderung wirkt sofort', k.ganz('count.enemy', null, 0) === 12)
    t.check('und meldet sich beim Hörer', gerufen === 1)

    abos.agent_settings({ action: 'update', record: { key: 'wd.count.enemy', value: 500, owner: 'konto-b' } })
    t.check('eine fremde Änderung wird verworfen', k.ganz('count.enemy', null, 0) === 12)

    process.env.WD_COUNT_ENEMY = '4'
    abos.agent_settings({ action: 'update', record: { key: 'wd.count.enemy', value: null, owner: 'konto-a' } })
    t.check('leeren gibt die Env wieder frei', k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 4)
    abos.agent_settings({ action: 'delete', record: { key: 'wd.count.enemy', owner: 'konto-a' } })
    t.check('löschen ebenso', k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 4)
    delete process.env.WD_COUNT_ENEMY
  }

  // ── Präfix ──────────────────────────────────────────────────────────────
  {
    const { ajna } = fakeAjna({
      daten: {
        agent_settings: [
          { key: 'wd.takt', value: 100, owner: 'konto-a' },
          { key: 'poi.takt', value: 900, owner: 'konto-a' },
        ],
      },
    })
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('das Präfix hält zwei Agents am selben Konto auseinander',
      k.ganz('takt', null, 0) === 100)
  }

  // ── Ohne Datenbank läuft es weiter ──────────────────────────────────────
  {
    let versuche = 0
    const ajna = { pb: {
      authStore: { record: { id: 'konto-a' } },
      collection: () => ({
        getFullList: async () => { throw new Error('collection fehlt') },
        subscribe: async () => { throw new Error('kein Realtime') },
        create: async () => { versuche++; throw new Error('collection fehlt') },
      }),
    } }
    process.env.WD_COUNT_ENEMY = '4'
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('eine fehlende Collection wirft den Agenten nicht raus',
      k.ganz('count.enemy', 'WD_COUNT_ENEMY', 3) === 4)
    // Ein Agent haengt sich an fremde Server; aeltere kennen die Collection
    // nicht. 22 zum Scheitern verurteilte Schreibversuche bei JEDEM Start
    // waeren Laerm auf einem Server, der davon gar nichts wissen will.
    await k.saee([{ name: 'a', vorgabe: 1 }, { name: 'b', vorgabe: 2 }])
    t.check('und wird auch nicht mit Anlege-Versuchen beworfen', versuche === 0,
      `${versuche} Versuche`)
    delete process.env.WD_COUNT_ENEMY
  }

  // ── Nicht angemeldet ────────────────────────────────────────────────────
  {
    const { ajna, rufe } = fakeAjna({ ich: null })
    const k = await Konfig.eigene(ajna, { praefix: 'wd', log: still })
    t.check('ohne Anmeldung wird gar nicht erst gelesen', !rufe.some(r => r.op === 'list'))
    t.check('und nichts angelegt', (await k.saee([{ name: 'x', vorgabe: 1 }])) === 0)
  }

  if (failures) { console.error(`\n${failures} fehlgeschlagen`); process.exit(1) }
  console.log('\n✓ Konfig: alles grün')
}

run().catch(err => { console.error(err); process.exit(1) })
