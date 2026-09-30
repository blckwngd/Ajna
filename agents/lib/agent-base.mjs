// agents/lib/agent-base.mjs — gemeinsamer Unterbau aller Node-Agents.
//
// Ein neuer Agent braucht damit nur noch:
//
//   import { bootAgent, envNum } from './lib/agent-base.mjs'
//   const { ajna, log, warn } = await bootAgent('mein-agent')
//   const RADIUS = envNum('MEIN_RADIUS_M', 100)
//   …Fachlogik…
//
// bootAgent erledigt in der richtigen Reihenfolge:
//   1. Geschichtete .env laden (Prozess-Env > agents/.env.<name> > Root-.env)
//   2. optional Erststart-Wizard (fehlende Pflichtwerte oder --setup, nur TTY)
//   3. HTTPS: einmaliger Re-Exec mit --use-system-ca (Caddys interne CA)
//   4. Pflicht-Env prüfen (AJNA_USER/PASS + opts.require)
//   5. AjnaManager anlegen + einloggen (+ optional connect())
//   6. Standard-SIGINT-Handler (abschaltbar für eigene Aufräumlogik)
//
// ABGRENZUNG: Hier liegt nur Node-Spezifisches (fs/env/process/Re-Exec).
// Browserfähige Logik (Geo-Mathe, PB-Zugriffe, Manifeste, …) gehört nach
// client/core — die Agents nutzen dieselbe Library per Node (AjnaManager & Co).

import { loadAgentEnv, agentEnvPath } from './env.mjs'
import { maybeReexecWithSystemCa } from './system-ca.mjs'
import { EventSource } from 'eventsource'
// PB-SDK öffnet bei connect()/refreshObjects() eine Realtime-SSE über
// globalThis.EventSource — in Node je nach Version nicht verfügbar → Polyfill.
if (typeof globalThis.EventSource !== 'function') globalThis.EventSource = EventSource

import { AjnaManager } from '../../client/core/AjnaManager.js'

/** Fehlermeldung + Exit 1 — einheitliches Sterben für alle Agents. */
export function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

// ─── Env-Parser ───────────────────────────────────────────────────────────
// Konvention: unset/leer → Default. Gesetzt, aber unbrauchbar → sofort die()
// mit klarer Meldung (statt still NaN durch die Fachlogik zu schleifen).

/** String-Wert; leerer String bleibt leer (bewusst ?? statt ||). */
export const envStr = (key, def = '') => process.env[key] ?? def

/** Fließkommazahl (auch für Ganzzahlen ok, solange kein Radix-Thema). */
export function envNum(key, def) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = parseFloat(raw)
  if (!Number.isFinite(v)) die(`${key}="${raw}" ist keine Zahl`)
  return v
}

/** Ganzzahl (Basis 10). */
export function envInt(key, def) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = parseInt(raw, 10)
  if (!Number.isFinite(v)) die(`${key}="${raw}" ist keine Ganzzahl`)
  return v
}

/** Schalter: 1/true/yes/on (case-insensitiv) = an, alles andere = aus. */
export function envBool(key, def = false) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  return /^(1|true|yes|on)$/i.test(raw)
}

/**
 * Darf dieser Absender dem Agenten Kommandos geben?
 *
 * `/api/agents/{source}/command` nimmt Kommandos von JEDEM angemeldeten Konto
 * entgegen — der Server prüft nur, DASS jemand angemeldet ist. Immerhin setzt
 * er `evt.source` auf die Konto-ID des Absenders, und die ist fälschungssicher.
 * Nur hat sie bisher niemand gelesen.
 *
 * Voreinstellung ist bewusst „jeder darf“: Kommandos wie „spawn“ sind Teil des
 * Spiels, und die Agents begrenzen sie ohnehin über Abklingzeiten und Obergrenzen.
 * Wer es enger will, gibt eine Liste an — dann gilt sie strikt.
 *
 * @param {{source?: string}} evt   Ereignis aus onAgentCommand (source = Konto-ID)
 * @param {string|string[]} [allow] Erlaubte Konto-IDs; leer/undefiniert = alle
 * @returns {boolean}
 */
export function commandAllowed(evt, allow) {
  const liste = (Array.isArray(allow) ? allow : String(allow || '').split(','))
    .map(x => String(x).trim()).filter(Boolean)
  if (!liste.length) return true
  return liste.includes(String(evt?.source || ''))
}

const TRENNER = String.fromCharCode(10)

/**
 * Den vorhandenen Bestand einlesen — oder aufgeben.
 *
 * WARUM DAS EINE EIGENE FUNKTION IST, UND WARUM SIE HART AUFGIBT:
 *
 * Fast jeder Agent beginnt damit, seine eigenen Objekte wiederzuerkennen
 * („adoptieren"): Schiffe an `state.mmsi`, Flugzeuge an `state.icao24`, Figuren
 * an `state.figure_id`. Was er dabei NICHT findet, legt er gleich darauf neu an.
 * Das ist richtig — solange die Liste die Wahrheit sagt.
 *
 * Am 17.09.2026 fiel `getFullList()` aus. Elf Agents hatten den Aufruf jeweils
 * in ein eigenes `try/catch` gepackt, eine Warnung geloggt und **mit leerem
 * Bestand weitergemacht**. Aus „ich konnte nicht fragen" wurde damit „es gibt
 * nichts", und in 25 Minuten entstanden 281 Dubletten. Zwei Agents stürzten
 * stattdessen ab — das war die freundlichere Variante, denn man sah es sofort.
 *
 * Deshalb gibt es hier keine dritte Möglichkeit: Entweder der Bestand ist
 * gelesen, oder der Agent läuft nicht. Ein Prozessabbruch kostet einen Neustart
 * durch pm2; eine stille Dublettenflut kostet einen Abend Aufräumen — und die
 * Objekte, die dabei verlorengehen, gehören inzwischen Spielern.
 *
 * Vorher wird es mehrfach versucht: Ein Server, der gerade neu startet, ist
 * kein Grund aufzugeben, und genau dieser Fall trifft beim gemeinsamen
 * Hochfahren von Stack und Agents zuverlässig zu.
 *
 * @param {object} ajna         AjnaManager
 * @param {object} [opts]
 * @param {string} [opts.tag]       Log-Präfix
 * @param {number} [opts.versuche]  wie oft insgesamt (Vorgabe 3)
 * @param {number} [opts.pauseMs]   Wartezeit nach dem ersten Fehlversuch; sie
 *                                  wächst mit jedem weiteren (Vorgabe 3000)
 * @param {Function} [opts.aufgeben] nur für Tests — sonst `die`
 * @returns {Promise<Array>} die Objekte, die der Agent sehen darf
 */
export async function ladeBestand(ajna, opts = {}) {
  const { tag = 'ajna', aufgeben = die } = opts
  const r = await mitWiederholung(
    async () => { await ajna.refreshObjects(); return ajna.getObjects() },
    { ...opts, tag, was: 'Bestand lesen' })
  if (r.ok) return r.wert
  return aufgeben([
    `[${tag}] Bestand nicht lesbar (${opts.versuche ?? 3} Versuche): ${r.grund}`,
    '  Ohne ihn wuerde dieser Agent alles neu anlegen, was es laengst gibt.',
    '  Deshalb Abbruch statt Weiterlaufen — pm2 startet neu, sobald der Server antwortet.',
  ].join(TRENNER))
}

/**
 * Etwas mehrfach versuchen, bevor es als gescheitert gilt.
 *
 * Gibt `{ok: true, wert}` oder `{ok: false, grund}` zurück — NIE einen
 * Ersatzwert. Wer einen Ausfall in einen leeren Wert übersetzt, baut genau die
 * Falle, gegen die `ladeBestand` existiert.
 */
async function mitWiederholung(tun, opts = {}) {
  const { tag = 'ajna', versuche = 3, pauseMs = 3000, warn = console.warn, was = 'Aufruf' } = opts
  for (let versuch = 1; versuch <= versuche; versuch++) {
    try {
      return { ok: true, wert: await tun() }
    } catch (err) {
      const grund = err?.response?.data?.message || err?.message || String(err)
      if (versuch >= versuche) return { ok: false, grund }
      warn(`[${tag}] ${was} fehlgeschlagen (Versuch ${versuch}/${versuche}): ${grund}`)
      await new Promise(r => setTimeout(r, pauseMs * versuch))
    }
  }
}

/** Agent-Manifest publishen — best effort (Fehler nur warnen, nie sterben). */
export async function publishManifest(ajna, manifest, warn = console.warn) {
  try {
    await ajna.upsertAgentManifest(mitDelegierten(manifest))
    // ERFOLG HEISST NICHT, DASS DER NAME UNS GEHÖRT.
    //
    // Der eindeutige Index steht auf (source, owner), nicht auf source allein:
    // ein zweites Konto darf denselben Quellnamen anlegen, und der Upsert
    // meldet brav Erfolg. Der Objekt-Hook nimmt dann aber den ÄLTEREN Eintrag,
    // und jedes Objekt scheitert mit 403 — "Manifest veröffentlicht", gefolgt
    // von einer endlosen Fehlerspalte. Genau so stand die C-ITS-Brücke am
    // 30.09.2026 auf dem VPS.
    await inhaberschaftPruefen(ajna, manifest, warn)
    return true
  }
  catch (err) {
    // Hier landet nur, was schon beim Schreiben scheiterte. Auch dann ist die
    // Meldung des Servers unbrauchbar („Failed to create record"), also erst
    // nachsehen, wem der Name gehört.
    await inhaberschaftPruefen(ajna, manifest, warn)
    warn('Manifest-Upsert fehlgeschlagen:', err?.message || err)
    return false
  }
}

/**
 * Gehört uns der Quellname wirklich? Wenn nicht: abbrechen.
 *
 * Es gilt der ÄLTESTE Eintrag — dieselbe Regel, nach der `AgentFilters.js` im
 * Client entscheidet, welches von zwei Manifesten zählt. Wer dort als
 * `delegates` eingetragen ist, darf ebenfalls; das ist der vorgesehene Weg für
 * einen Betreiber mit zwei Konten.
 */
async function inhaberschaftPruefen(ajna, manifest, warn = console.warn) {
  const inhaber = await manifestInhaber(ajna, manifest?.source)
  const ich = ajna.currentUser?.()?.id
  if (!inhaber || !ich || !inhaber.owner || inhaber.owner === ich) return
  const erlaubt = Array.isArray(inhaber.delegates) ? inhaber.delegates : []
  if (erlaubt.includes(ich)) return

  const wer = inhaber.owner_handle ? `@${inhaber.owner_handle} (${inhaber.owner})` : inhaber.owner
  die(`Die Quelle "${manifest.source}" gehört auf diesem Server bereits ${wer}.\n`
    + `  Dieses Konto (${ich}) kann damit KEINE Objekte anlegen — der Server weist jeden\n`
    + `  Schreibversuch mit 403 ab ("gehört einem anderen Konto"). Dass das Manifest\n`
    + `  eben angenommen wurde, ändert daran nichts: es gilt der ältere Eintrag.\n`
    + `\n`
    + `  Drei Wege:\n`
    + `    1. Den Agenten mit dem Konto starten, dem der Name gehört.\n`
    + `    2. Gehören beide Konten dir: ${ich} beim älteren Manifest unter\n`
    + `       "delegates" eintragen (Sammlung agent_manifests).\n`
    + `    3. Den älteren Eintrag löschen. ACHTUNG: dessen Objekte bleiben in\n`
    + `       fremdem Besitz und werden danach unveränderlich — vorher aufräumen.`)
}

/**
 * Wer hält einen Quellnamen auf diesem Server? `null`, wenn niemand.
 *
 * Der ÄLTESTE Eintrag gewinnt, nicht der erstbeste: bei zwei Ansprüchen hängt
 * die Reihenfolge einer ungeordneten Liste sonst vom Zufall ab, und der Client
 * entschiede anders als wir.
 *
 * Bewusst über die Liste statt über einen gefilterten Einzelabruf: Lesen darf
 * jeder Angemeldete, und ein 404 aus einem Filter ließe sich nicht von einem
 * Rechteproblem unterscheiden.
 */
async function manifestInhaber(ajna, source) {
  if (!source) return null
  try {
    const alle = await ajna.listAgentManifests()
    return alle.filter(m => m?.source === source)
      .sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))[0] || null
  } catch { return null }
}

/**
 * Delegierte Konten aus `AJNA_DELEGATES` ergänzen — Komma-Liste von Konto-IDs.
 *
 * WOFÜR: Ein Betreiber, der seine Agents unter einem ZWEITEN Konto ausrollt,
 * bekommt sonst für alles, was dieses Konto anlegt, ein rotes „⚠ angeblich …":
 * Der Name gehört dem Konto, das ihn zuerst registriert hat, und der Client
 * kann einen zweiten Anspruch nicht von einer Fälschung unterscheiden.
 *
 * Gesetzt wird die Liste beim NAMENSINHABER — nur dessen Manifest wird gelesen,
 * und schreiben kann es nur er selbst (updateRule). Ein Fremdkonto kann sich
 * damit nicht eintragen; siehe Migration 1787800000.
 *
 * Ohne die Variable bleibt `delegates` UNANGETASTET: Ein Agent, der nichts von
 * Delegation weiß, soll die Liste nicht bei jedem Start löschen.
 */
export function mitDelegierten(manifest) {
  if (Array.isArray(manifest?.delegates)) return manifest
  const roh = (process.env.AJNA_DELEGATES || '').trim()
  if (!roh) return manifest
  const ids = roh.split(',').map(x => x.trim()).filter(Boolean)
  return ids.length ? { ...manifest, delegates: ids } : manifest
}

/**
 * Gemeinsamer Agent-Bootstrap.
 *
 * @param {string} name  Agent-Name: bestimmt agents/.env.<name> und den
 *                       Log-Prefix (opts.tag überschreibt letzteren).
 * @param {object} [opts]
 * @param {string}   [opts.tag]      Log-Prefix (Default: name)
 * @param {string[]} [opts.require]  zusätzliche Pflicht-Env-Keys
 * @param {boolean}  [opts.login=true]    AJNA_USER/PASS verlangen + einloggen
 * @param {string}   [opts.handle]   gewünschter Konto-Handle (users.username).
 *                                   Wird nur gesetzt, wenn das Konto noch keinen
 *                                   hat; ein vorhandener bleibt unangetastet.
 * @param {boolean}  [opts.connect=false] nach Login ajna.connect() (Objekt-
 *                                        Cache + Realtime-Subscription)
 * @param {boolean}  [opts.sigint=true]   Standard-SIGINT-Handler (Log + Exit 0);
 *                                        false für eigene Aufräumlogik
 * @param {{need: string[], run: () => Promise<{exit?: boolean}|void>}} [opts.setup]
 *   Erststart-Wizard: läuft bei --setup oder wenn einer der `need`-Keys fehlt.
 *   Ohne TTY: fehlende Keys → Exit 1 mit Hinweis; nur --setup → ignoriert.
 *   `run()` schreibt die Agent-.env und setzt process.env (siehe env.mjs);
 *   gibt es { exit: true } zurück (z. B. Übergabe an pm2), endet der Prozess.
 * @returns {Promise<{ajna: AjnaManager, url: string, log: Function, warn: Function}>}
 */
export async function bootAgent(name, opts = {}) {
  const tag = opts.tag || name
  const log = (...a) => console.log(`[${tag}]`, ...a)
  const warn = (...a) => console.warn(`[${tag}]`, ...a)

  loadAgentEnv(name)

  if (opts.setup) {
    const wantSetup = process.argv.includes('--setup')
    const missing = (opts.setup.need || []).filter(k => !process.env[k])
    if (wantSetup || missing.length) {
      if (!process.stdin.isTTY) {
        if (missing.length) {
          console.error(`✗ Konfiguration unvollständig (${agentEnvPath(name)} fehlt/leer): ${missing.join(', ')}`)
          console.error(`  Interaktiv einrichten:  node ${process.argv[1]} --setup`)
          process.exit(1)
        }
        // --setup ohne TTY (z. B. via pm2): ignorieren, normal starten.
      } else {
        const res = await opts.setup.run()
        if (res?.exit) process.exit(0)
      }
    }
    // --setup nicht in den System-CA-Re-Exec (unten) mitschleppen — der Wizard
    // lief bereits; im Kind-Prozess würde er sonst ein zweites Mal starten.
    process.argv = process.argv.filter(a => a !== '--setup')
  }

  const url = process.env.AJNA_URL || 'http://127.0.0.1:8090'
  // Muss VOR dem ersten HTTPS-Zugriff laufen; der Re-Exec startet das ganze
  // Skript neu, alles bis hierher läuft dann (billig) doppelt.
  maybeReexecWithSystemCa(url)

  const doLogin = opts.login !== false
  const required = [...(doLogin ? ['AJNA_USER', 'AJNA_PASS'] : []), ...(opts.require || [])]
  const absent = required.filter(k => !process.env[k])
  if (absent.length) die(`Fehlende Konfiguration: ${absent.join(', ')} (agents/.env.${name}, Root-.env oder Env)`)

  const ajna = new AjnaManager(url)
  if (doLogin) {
    try { await ajna.login(process.env.AJNA_USER, process.env.AJNA_PASS) }
    catch (err) { die(`Ajna-Login fehlgeschlagen: ${err?.response?.data?.message || err?.message || err}`) }
    log(`eingeloggt als ${ajna.currentUser()?.email || process.env.AJNA_USER} @ ${url}`)
  }
  // Handle am Konto setzen — NUR, wenn dort noch keiner steht. Ein bestehender
  // Name wird nie überschrieben: Umbenennen ist eine Entscheidung des Menschen,
  // dem das Konto gehört, nicht des Programms, das gerade startet.
  //
  // Das Betreiber-Siegel (`agent_seal`) setzt der Agent ausdrücklich NICHT —
  // es ist die Aussage des Betreibers, nicht die des Agenten über sich selbst.
  if (doLogin && opts.handle) {
    const me = ajna.currentUser()
    if (!me?.username) {
      try {
        await ajna.updateCurrentUser({ username: opts.handle })
        log(`Handle gesetzt: @${opts.handle}`)
      } catch (err) {
        const msg = err?.response?.data?.username?.message || err?.message || err
        warn(`Handle "@${opts.handle}" nicht gesetzt (${msg}) — der Agent läuft trotzdem.`)
      }
    } else if (me.username !== opts.handle) {
      warn(`Konto führt bereits @${me.username}, gewünscht war @${opts.handle} — unverändert gelassen.`)
    }
  }

  // Verbinden heisst: Realtime abonnieren UND den Bestand einlesen. Faellt es
  // aus, gilt dasselbe wie bei `ladeBestand` — ein Agent ohne Bestand legt
  // alles ein zweites Mal an. Also mehrfach versuchen und sonst sterben, statt
  // mit einer leeren Welt weiterzumachen.
  if (opts.connect) {
    const r = await mitWiederholung(() => ajna.connect(), { tag, warn, was: 'Verbinden' })
    if (!r.ok) {
      die([
        `[${tag}] Verbindung zu ${url} fehlgeschlagen: ${r.grund}`,
        '  Ohne Verbindung kennt dieser Agent seinen Bestand nicht und wuerde ihn neu anlegen.',
      ].join(TRENNER))
    }
  }

  if (opts.sigint !== false) {
    process.on('SIGINT',  () => { console.log(`\n[${tag}] beende.`); process.exit(0) })
    // pm2/systemd stoppen per SIGTERM — ohne Handler stürbe der Agent zwar
    // auch, aber ohne Log-Zeile und mit Exit-Code ≠ 0.
    process.on('SIGTERM', () => { console.log(`[${tag}] beende (SIGTERM).`); process.exit(0) })
  }

  return { ajna, url, log, warn }
}
