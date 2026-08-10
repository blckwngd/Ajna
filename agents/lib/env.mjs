// Geschichtetes .env-Laden für Agenten.
//
// Jeder Agent hat SEINE eigene Datei mit agent-spezifischen Werten:
//     agents/.env.<agent>          (vom Setup-Wizard geschrieben; gitignored)
// Liegt der Agent auf dem Ajna-Server selbst, dient die Root-.env des Repos
// als FALLBACK für globale Werte (URLs, Ports, geteilte Keys). Auf einem
// externen System fehlt sie einfach — die Agent-.env muss dann alles enthalten.
//
// Präzedenz (höher gewinnt):  echte Prozess-Umgebung  >  Agent-.env  >  Root-.env
// Bereits gesetzte process.env-Variablen werden NIE überschrieben.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))   // …/agents

/** Pfad der agent-eigenen .env (agents/.env.<agent>). */
export const agentEnvPath = (agent) => resolve(AGENTS_DIR, `.env.${agent}`)
/** Pfad der Repo-Root-.env (globaler Fallback bei lokaler Ajna-Instanz). */
export const rootEnvPath = () => resolve(AGENTS_DIR, '..', '.env')

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.replace(/^\s*#.*$/, '').trim().match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** Liest die Agent-.env als Objekt (leer, wenn sie fehlt) — ohne process.env anzufassen. */
export const readAgentEnv = (agent) =>
  existsSync(agentEnvPath(agent)) ? parseEnvFile(agentEnvPath(agent)) : {}

/**
 * Lädt die Env-Schichten des Agenten in process.env (ohne Überschreiben).
 * @returns {{[key:string]: string}} key → Quelldatei (für Diagnose)
 */
export function loadAgentEnv(agent) {
  const sources = {}
  for (const path of [agentEnvPath(agent), rootEnvPath()]) {
    if (!existsSync(path)) continue
    for (const [k, v] of Object.entries(parseEnvFile(path))) {
      if (process.env[k] === undefined) { process.env[k] = v; sources[k] = path }
    }
  }
  return sources
}

/**
 * Schreibt die Agent-.env (komplett, mit Kopfkommentar) und setzt die Werte
 * zugleich in process.env (überschreibend — der Wizard IST die neue Wahrheit).
 * Datei wird auf 0600 gesetzt (enthält Zugangsdaten).
 * @param {string} agent
 * @param {{[key:string]: string|number|undefined|null}} entries  null/undefined = auslassen
 * @param {string} [header]  Kommentarzeilen (ohne führendes #)
 */
export function writeAgentEnv(agent, entries, header = '') {
  const path = agentEnvPath(agent)
  const lines = []
  lines.push(`# agents/.env.${agent} — vom Setup-Wizard geschrieben (${new Date().toISOString()})`)
  for (const h of header.split('\n').filter(Boolean)) lines.push(`# ${h}`)
  lines.push('')
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined || v === null || v === '') continue
    const s = String(v)
    lines.push(/[\s#"']/.test(s) ? `${k}="${s.replace(/"/g, '\\"')}"` : `${k}=${s}`)
    process.env[k] = s
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  try { chmodSync(path, 0o600) } catch {}   // Windows: no-op, ok
  return path
}
