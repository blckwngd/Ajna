#!/usr/bin/env node
// robot-agent.mjs — einen Roboter als Ajna-Objekt betreiben.
//
// LÄUFT HEADLESS. Node auf einem Raspberry Pi, einem Laptop oder sonstwo —
// kein Browser, kein Capacitor, keine Oberfläche. Die Android-App führt
// denselben Kern (`lib/robot.mjs`) aus; sie ist der Sonderfall, nicht dieser
// Weg. Wer das umdreht, baut die Logik zweimal.
//
// OHNE HARDWARE AUSPROBIEREN:
//
//     npm run robot            # Simulationstreiber, fährt wirklich im Kreis
//
// Das ist Stufe 0 aus docs/arbeitspakete.md, Paket 6: Agent, Navigation,
// Spielaktionen und Ajna-Objekt sind echt, nur die Räder nicht. Jeder Fehler,
// der nicht in den Motoren sitzt, zeigt sich hier zuerst — wo er nichts kostet.
//
// EINEN ECHTEN TREIBER ANSCHLIESSEN: `lib/robot-driver.mjs` beschreibt den
// Vertrag (sechs Methoden), `checkDriver()` prüft ihn. Danach hier in
// `treiberBauen()` eintragen.

import { bootAgent, envNum, envStr, publishManifest } from './lib/agent-base.mjs'
import { Robot } from './lib/robot.mjs'
import { SimDriver } from './lib/robot-driver.mjs'
import { simpleSetup } from './lib/setup-wizard.mjs'

const { ajna, log, warn } = await bootAgent('robot', {
  tag: 'robot',
  // EIGENES BEENDEN. Der Standard-Handler ruft sofort `process.exit(0)` — bei
  // einem Agenten, der nur Daten spiegelt, ist das richtig. Hier fährt eine
  // Maschine: Sie muss erst stehen, dann darf der Prozess gehen.
  sigint: false,
  setup: simpleSetup('robot', {
    required: ['AJNA_USER', 'AJNA_PASS'],
    optional: ['AJNA_URL', 'ROBOT_NAME', 'ROBOT_START_LAT', 'ROBOT_START_LON'],
  }),
})

const NAME = envStr('ROBOT_NAME', 'Rover')
const SOURCE = envStr('ROBOT_SOURCE', 'robot')
const TREIBER = envStr('ROBOT_DRIVER', 'sim')
const START_LAT = envNum('ROBOT_START_LAT', 50.4514)
const START_LON = envNum('ROBOT_START_LON', 7.5363)
const MAX_V = envNum('ROBOT_MAX_V', 1.0)
const MAX_OMEGA = envNum('ROBOT_MAX_OMEGA', 1.0)

/**
 * Den Treiber für diese Maschine bauen.
 *
 * Hier und NUR hier steht, welche Plattform es ist. Alles darüber kennt nur
 * `fahre({ v, omega })`.
 */
function treiberBauen() {
  switch (TREIBER) {
    case 'sim':
      return new SimDriver({
        start: { lat: START_LAT, lon: START_LON, heading: 0 },
        maxV: MAX_V, maxOmega: MAX_OMEGA,
        slipp: envNum('ROBOT_SIM_SLIP', 0),
      })
    // case 'hoverboard': return new HoverboardDriver({ … })   // ESP32 über BLE
    // case 'hexapod':    return new HexapodDriver({ … })
    default:
      console.error(`✗ Unbekannter Treiber „${TREIBER}". Bekannt: sim`)
      console.error('  Einen eigenen schreiben: siehe agents/lib/robot-driver.mjs')
      process.exit(1)
  }
}

const driver = treiberBauen()
log(`Treiber: ${TREIBER} · max ${MAX_V} m/s, ${MAX_OMEGA} rad/s`)
if (TREIBER === 'sim') log('SIMULATION — es bewegt sich nichts Echtes.')

if (await publishManifest(ajna, {
  source: SOURCE,
  agent_name: `Roboter: ${NAME}`,
  description: 'Ein teilautonomes Gerät in der echten Welt, als Spielobjekt ansprechbar',
  render_range_m: envNum('ROBOT_RENDER_RANGE_M', 2000),
  layers: [{ key: 'all', label: 'Roboter', predicate: null }],
})) log('Manifest veröffentlicht')

const robot = new Robot({
  ajna, driver, name: NAME, source: SOURCE,
  tickMs: envNum('ROBOT_TICK_MS', 200),
  publishMs: envNum('ROBOT_PUBLISH_MS', 1000),
  limits: { maxV: MAX_V, maxOmega: MAX_OMEGA },
  log, warn,
})

await robot.start()

// Befehle von aussen: `ajna.sendAgentCommand('robot', 'goto', { lat, lon })`.
// Derselbe Draht, den der World-Director benutzt — für Skripte, Aufträge und
// die Fernbedienung durch den Betreiber.
ajna.onAgentCommand(SOURCE, async (evt) => {
  try {
    if (evt?.command === 'goto' && evt.payload) {
      const n = robot.fahreZu(evt.payload)
      log(`Kommando goto → ${n} Wegpunkt(e)`)
    } else if (evt?.command === 'halt') {
      await robot.halt('angehalten per Kommando')
    }
  } catch (err) { warn(`Kommando: ${err?.message || err}`) }
}).catch(err => warn(`Kommando-Abo: ${err?.message || err}`))

setInterval(() => {
  const s = robot.status()
  log(`${s.text}${s.wegpunkteOffen ? ` · ${s.wegpunkteOffen} Wegpunkt(e)` : ''}`
    + (s.pose ? ` · ${s.pose.lat.toFixed(5)}, ${s.pose.lon.toFixed(5)}` : ''))
}, envNum('ROBOT_REPORT_S', 30) * 1000)

// ANHALTEN GEHT VOR AUFRÄUMEN. Beim Beenden zuerst die Maschine stoppen, dann
// alles andere — ein sauber abgemeldetes Objekt nützt nichts, wenn der Rover
// derweil weiterfährt.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    robot.stop()
      .catch(err => console.warn('[robot] Beenden:', err?.message || err))
      .finally(() => process.exit(0))
  })
}
