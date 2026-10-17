// Tests für agents/lib/robot.mjs — den plattformunabhängigen Kern.
//
// Schwerpunkt ist das Anhalten. Ein Roboter, der aus Versehen weiterfährt, ist
// die einzige Art Fehler, die hier wehtun kann — alles andere ist ein Objekt
// an der falschen Stelle auf einer Karte.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Robot, targetFrom } from './robot.mjs'
import { SimDriver } from './robot-driver.mjs'

const HIER = { lat: 50.4514, lon: 7.5363 }

/** Ein Ajna, das mitschreibt statt zu reden. */
function ajnaDoppel() {
  const protokoll = []
  let interakt = null
  return {
    protokoll,
    letzterStand: () => protokoll.filter(p => p[0] === 'update').pop()?.[2] || null,
    ausloesen: (evt) => interakt?.(evt),
    async createObject(data) { protokoll.push(['create', data]); return { id: 'rob1', ...data } },
    async updateObject(id, patch) { protokoll.push(['update', id, patch]); return { id } },
    async subscribeInteract(id, cb) { interakt = cb; return () => { interakt = null } },
  }
}

/** Steuerbare Uhr für Treiber und Kern zugleich. */
function uhr(start = 1_000_000) {
  let t = start
  return { jetzt: () => t, vor: (ms) => { t += ms } }
}

function bau(opts = {}) {
  const u = uhr()
  const ajna = ajnaDoppel()
  const driver = new SimDriver({ start: { ...HIER, heading: 0 }, maxV: 1, maxOmega: 1, now: u.jetzt })
  const robot = new Robot({
    ajna, driver, name: 'Testrover', now: u.jetzt,
    log: () => {}, warn: () => {}, ...opts,
  })
  return { u, ajna, driver, robot }
}

// ─── Anlegen und Anmelden ─────────────────────────────────────────────────

test('beim Start entsteht ein Objekt mit Aktionen', async () => {
  const { ajna, robot } = bau()
  await robot.start()
  await robot.stop()
  const [art, daten] = ajna.protokoll[0]
  assert.equal(art, 'create')
  assert.equal(daten.type, 'robot')
  const keys = daten.state.actions.map(a => a.key)
  assert.deepEqual(keys, ['come', 'halt'])
  // Reichweite ist hier zugleich Spielregel und Sicherung: Wer den Rover ruft,
  // muss in Rufweite stehen.
  assert.ok(daten.state.actions.every(a => a.max_distance > 0))
})

test('die Plattform bestimmt, welche Aktionen es gibt', async () => {
  // Ein Hexapod kann sich hinsetzen, ein Hoverboard nicht — und die Spiellogik
  // erfährt das vom Treiber, statt Plattformen zu kennen.
  const u = uhr()
  const beinig = new SimDriver({ now: u.jetzt })
  beinig.capabilities = () => ({
    maxV: 0.4, maxOmega: 0.8, turnsInPlace: true, holonomic: true,
    extraActions: [{ key: 'sit', label: 'Hinsetzen' }],
  })
  const ajna = ajnaDoppel()
  const robot = new Robot({ ajna, driver: beinig, now: u.jetzt, log: () => {}, warn: () => {} })
  await robot.start(); await robot.stop()
  const keys = ajna.protokoll[0][1].state.actions.map(a => a.key)
  assert.deepEqual(keys, ['come', 'halt', 'sit'])
})

test('die Grenzen der Maschine schlagen die Wunschwerte', async () => {
  const u = uhr()
  const lahm = new SimDriver({ maxV: 0.3, maxOmega: 0.2, now: u.jetzt })
  const robot = new Robot({
    ajna: ajnaDoppel(), driver: lahm, now: u.jetzt,
    limits: { maxV: 99, maxOmega: 99 }, log: () => {}, warn: () => {},
  })
  assert.equal(robot.limits.maxV, 0.3)
  assert.equal(robot.limits.maxOmega, 0.2)
})

test('ein unvollständiger Treiber wird gar nicht erst angenommen', () => {
  assert.throws(() => new Robot({ ajna: ajnaDoppel(), driver: { start() {} } }),
    /Treiber unvollständig/)
  assert.throws(() => new Robot({ driver: new SimDriver() }), /ajna fehlt/)
})

// ─── Fahren ───────────────────────────────────────────────────────────────

test('ein Ziel wird angefahren und erreicht', async () => {
  const { u, robot, driver } = bau({ tickMs: 0 })   // Takt von Hand
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.0002, lon: HIER.lon })   // ~22 m nördlich

  for (let i = 0; i < 200 && !robot.route.fertig; i++) {
    await robot.tick()
    u.vor(200)
  }
  assert.equal(robot.route.fertig, true, 'nicht angekommen')
  const p = driver.state().pose
  assert.ok(Math.abs((p.lat - (HIER.lat + 0.0002)) * 111320) < 2, 'daneben')
  await robot.stop()
})

test('am Ziel steht die Maschine wirklich still', async () => {
  const { u, robot, driver } = bau({ tickMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.0002, lon: HIER.lon })
  for (let i = 0; i < 200 && !robot.route.fertig; i++) { await robot.tick(); u.vor(200) }
  await robot.tick()
  assert.equal(driver.state().v, 0, 'fährt weiter')
  assert.equal(robot.zustand, 'arrived')
  await robot.stop()
})

// ─── Anhalten — der Teil, der wehtun kann ─────────────────────────────────

test('ohne Position wird angehalten, nicht geraten', async () => {
  const { u, robot, driver } = bau({ tickMs: 0, pose: () => null })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  await robot.tick()
  assert.equal(driver.state().v, 0)
  assert.equal(robot.zustand, 'fault')
  u.vor(1)
  assert.equal(robot.letzterFehler, 'keine Position')
  await robot.stop()
})

test('eine veraltete Position gilt als keine', async () => {
  // Eine Sekunde alte Koordinaten sind bei 1 m/s einen Meter daneben. Nach
  // drei Sekunden fährt die Maschine blind.
  const u = uhr()
  let alter = 0
  const ajna = ajnaDoppel()
  const driver = new SimDriver({ start: { ...HIER, heading: 0 }, now: u.jetzt })
  const robot = new Robot({
    ajna, driver, now: u.jetzt, tickMs: 0, poseMaxAgeMs: 3000,
    pose: () => ({ ...HIER, heading: 0, t: u.jetzt() - alter }),
    log: () => {}, warn: () => {},
  })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  await robot.tick()
  assert.notEqual(robot.zustand, 'fault', 'frisch ist in Ordnung')

  alter = 5000
  await robot.tick()
  assert.equal(robot.zustand, 'fault')
  assert.equal(driver.state().v, 0)
  await robot.stop()
})

test('meldet der Treiber eine Störung, wird gehalten', async () => {
  const { robot, driver } = bau({ tickMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  const echt = driver.state.bind(driver)
  driver.state = () => ({ ...echt(), error: 'Motor überhitzt' })
  await robot.tick()
  assert.equal(robot.zustand, 'fault')
  assert.match(robot.letzterFehler, /Motor überhitzt/)
  await robot.stop()
})

test('halt() räumt die Route weg — nicht nur die Fahrt', async () => {
  // Sonst führe die Maschine beim nächsten Takt einfach weiter.
  const { robot, driver } = bau({ tickMs: 0 })
  await robot.start()
  robot.fahreZu([{ lat: HIER.lat + 0.001, lon: HIER.lon }, { lat: HIER.lat + 0.002, lon: HIER.lon }])
  await robot.halt()
  assert.equal(robot.route.rest, 0)
  await robot.tick()
  assert.equal(driver.state().v, 0)
  await robot.stop()
})

test('stop() hält an, auch wenn das Abmelden scheitert', async () => {
  const { robot, driver } = bau({ tickMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  await robot.tick()
  driver.stop = async () => { throw new Error('Verbindung weg') }
  await robot.stop()
  assert.equal(driver.state().v, 0, 'die Maschine muss trotzdem stehen')
})

test('die Störungsmeldung wiederholt sich nicht bei jedem Takt', async () => {
  // Fünfmal je Sekunde „keine Position" wäre dieselbe Sorte Lärm wie
  // anderswo die wiederholten Statusmeldungen.
  const meldungen = []
  const { robot } = bau({ tickMs: 0, pose: () => null, warn: (t) => meldungen.push(t) })
  await robot.start()
  for (let i = 0; i < 5; i++) await robot.tick()
  assert.equal(meldungen.filter(m => m === 'keine Position').length, 1, meldungen.join(' | '))
  await robot.stop()
})

// ─── Spieler-Interaktion ──────────────────────────────────────────────────

test('„Herkommen" fährt zum Aufrufer', async () => {
  const { ajna, robot } = bau({ tickMs: 0 })
  await robot.start()
  await ajna.ausloesen({ action: 'come', payload: { lat: 50.4520, lon: 7.5370 }, source: 'u1' })
  assert.equal(robot.route.rest, 1)
  assert.deepEqual(robot.route.ziel, { lat: 50.4520, lon: 7.5370 })
  await robot.stop()
})

test('„Anhalten" wirkt sofort', async () => {
  const { ajna, robot, driver } = bau({ tickMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  await robot.tick()
  await ajna.ausloesen({ action: 'halt', source: 'u1' })
  assert.equal(driver.state().v, 0)
  assert.equal(robot.route.rest, 0)
  await robot.stop()
})

test('„Herkommen" ohne Position fährt nirgendwohin', async () => {
  const { ajna, robot } = bau({ tickMs: 0 })
  await robot.start()
  await ajna.ausloesen({ action: 'come', source: 'u1' })
  assert.equal(robot.route.rest, 0)
  await robot.stop()
})

test('das Ziel kommt aus der Nutzlast oder vom Aufrufer', () => {
  assert.deepEqual(targetFrom({ payload: { lat: 1, lon: 2 } }), { lat: 1, lon: 2 })
  assert.deepEqual(targetFrom({ position: { lat: 3, lon: 4 } }), { lat: 3, lon: 4 })
  assert.equal(targetFrom({ payload: { lat: 'x' } }), null)
  assert.equal(targetFrom({}), null)
  assert.equal(targetFrom(null), null)
})

// ─── Melden ───────────────────────────────────────────────────────────────

test('die Meldung trägt einen Bewegungsvektor', async () => {
  // Darum reicht ein Melde-Takt von einer Sekunde: Der Client rechnet daraus
  // frameweise voraus. Ohne Vektor spränge der Rover über die Karte.
  const { u, ajna, robot } = bau({ tickMs: 0, publishMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  await robot.tick()
  u.vor(500)
  await robot.tick()
  const stand = ajna.letzterStand()
  assert.ok(stand.state.motion, 'kein motion im Stand')
  assert.ok(Number.isFinite(stand.state.motion.v))
  assert.ok(Number.isFinite(stand.state.motion.trk))
  assert.equal(stand.state.motion.lat0, stand.lat)
  await robot.stop()
})

test('Stillstand wird als v = 0 gemeldet, nicht als Zittern', async () => {
  const { ajna, robot } = bau({ tickMs: 0, publishMs: 0 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.0000001, lon: HIER.lon })   // praktisch hier
  await robot.tick()
  const stand = ajna.letzterStand()
  if (stand?.state?.motion) assert.equal(stand.state.motion.v, 0)
  await robot.stop()
})

test('die Meldung ist gedrosselt', async () => {
  const { u, ajna, robot } = bau({ tickMs: 0, publishMs: 1000 })
  await robot.start()
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  const vorher = ajna.protokoll.filter(p => p[0] === 'update').length
  for (let i = 0; i < 4; i++) { await robot.tick(); u.vor(100) }
  const nachher = ajna.protokoll.filter(p => p[0] === 'update').length
  assert.equal(nachher - vorher, 1, 'vier Takte in 400 ms dürfen einmal melden')
  await robot.stop()
})

test('die Beschreibung sagt, was los ist', async () => {
  const { robot } = bau({ tickMs: 0 })
  await robot.start()
  assert.match(robot._beschreibung(), /Testrover/)
  robot.fahreZu({ lat: HIER.lat + 0.001, lon: HIER.lon })
  assert.match(robot._beschreibung(), /unterwegs|Wegpunkt/)
  await robot.stop()
})
