// ─────────────────────────────────────────────────────────────────────────
//  Agent library · Persona setup — an account of its own, sealed by the operator
// ─────────────────────────────────────────────────────────────────────────
// A persona needs what no other agent needs: its OWN user account, created
// before the agent can even log in. The other agents share one account from
// the root `.env`; a persona must not, because the account IS the character
// — its chat inbox, its inventory, its karma, its provenance badge.
//
// So this runs with superuser credentials (AJNA_SU / AJNA_SU_PASS from the
// root `.env`), once, and leaves behind `agents/.env.persona-<name>` with the
// account's own login. The superuser password never lands in that file.
//
// THE SEAL. `users.agent_seal` is the operator's statement "this account is
// an official agent of this instance". The client shows it as `✓ @handle`
// on everything the account owns (Provenance.js). No account can give the
// seal to itself — which is exactly why creating a persona is a superuser
// act and not something the agent does on first start.
//
// Pure where it can be: the account creation takes a PocketBase-like client
// so it can be exercised with a fake. Only `runSetup` touches the real
// network and the real file system.

import PocketBase from 'pocketbase'
import { randomBytes } from 'node:crypto'
import { writeAgentEnv, readAgentEnv, agentEnvPath } from './env.mjs'
import { NAME_PATTERN, sourceFor } from './persona-def.mjs'

/** A password nobody has to remember: the file remembers it. */
export const randomPassword = () => randomBytes(18).toString('base64url')

/** Login identity of a persona account — stable, derived from the name. */
export const emailFor = (name, domain = 'ajna.local') => `persona-${name}@${domain}`

/**
 * Create (or find) the persona's account as superuser.
 *
 * Idempotent on the email: a second run finds the account and only makes
 * sure the seal and the handle are in place. It never resets a password it
 * did not just create — the env file holds the only copy, and if that file
 * is gone, `resetPassword: true` is the explicit way to get a new one.
 *
 * @param {object} pb          PocketBase client, already authenticated as superuser
 * @param {object} persona     validated persona (from persona-def)
 * @param {object} [opts]
 * @param {string} [opts.domain]
 * @param {boolean} [opts.resetPassword]
 * @returns {Promise<{id, email, password|null, created, sealed}>}
 */
export async function ensureAccount(pb, persona, opts = {}) {
  const name = persona.name
  if (!NAME_PATTERN.test(name)) throw new Error(`persona name "${name}" is not a valid handle`)
  const email = emailFor(name, opts.domain)
  const users = pb.collection('users')

  let record = null
  try {
    record = await users.getFirstListItem(`email = "${email}"`)
  } catch (err) {
    if (err?.status !== 404) throw err
  }

  if (!record) {
    const password = randomPassword()
    record = await users.create({
      email,
      password, passwordConfirm: password,
      name: persona.figure.name,
      username: name,
      agent_seal: true,
      verified: true,
      guest: false,
    })
    return { id: record.id, email, password, created: true, sealed: true }
  }

  // Existing account: repair what the operator means, leave the rest alone.
  const patch = {}
  if (record.agent_seal !== true) patch.agent_seal = true
  if (!record.username) patch.username = name
  if (record.verified !== true) patch.verified = true
  let password = null
  if (opts.resetPassword) {
    password = randomPassword()
    patch.password = password
    patch.passwordConfirm = password
  }
  if (Object.keys(patch).length) record = await users.update(record.id, patch)
  return { id: record.id, email, password, created: false, sealed: record.agent_seal === true }
}

/**
 * Write `agents/.env.persona-<name>`: the account's login, plus whatever
 * the operator passed through. Existing keys survive (the API key the
 * operator will add later must not be wiped by a re-run); only what this
 * call knows better is replaced.
 */
export function writePersonaEnv(name, { email, password, url, extra = {} } = {}) {
  const agent = `persona-${name}`
  const current = readAgentEnv(agent)
  const entries = { ...current, ...extra }
  entries.AJNA_USER = email
  if (password) entries.AJNA_PASS = password
  if (url) entries.AJNA_URL = url
  return writeAgentEnv(agent, entries, [
    `Persona "${name}" — account of its own, created by: node agents/persona.mjs --persona ${name} --setup`,
    `AJNA_USER/AJNA_PASS are THIS persona's login (not the shared agent account).`,
    `Source of its objects: ${sourceFor(name)}`,
    `For language-model modes add: ANTHROPIC_API_KEY=…  (never in the database, never in the repo)`,
    `Optional: OPENAI_API_KEY / OPENAI_BASE_URL for an OpenAI-compatible endpoint (Ollama, vLLM)`,
  ].join('\n'))
}

/**
 * The whole setup: superuser login, account, env file.
 *
 * Non-interactive by design — the interactive questions (if any) belong to
 * the caller; this function only needs the facts. Returns what it did so the
 * caller can say it in its own words.
 */
export async function runSetup(persona, {
  url,
  su, suPass,
  domain,
  resetPassword = false,
  extra = {},
  client = null,          // for tests: a ready, authenticated fake
} = {}) {
  if (!su || !suPass) {
    throw new Error('AJNA_SU and AJNA_SU_PASS are required to create a persona account (root .env)')
  }
  const pb = client || new PocketBase(url)
  if (!client) {
    try {
      await pb.collection('_superusers').authWithPassword(su, suPass)
    } catch (err) {
      const detail = err?.response?.data?.message || err?.message || String(err)
      throw new Error(`superuser login failed at ${url}: ${detail}`)
    }
  }
  const account = await ensureAccount(pb, persona, { domain, resetPassword })

  // Without a password there is nothing to write unless a file already
  // holds one — then the login still works and only the seal was repaired.
  const existing = readAgentEnv(`persona-${persona.name}`)
  if (!account.password && !existing.AJNA_PASS) {
    throw new Error(`account ${account.email} exists but ${agentEnvPath(`persona-${persona.name}`)} has no password — `
      + `run again with --reset-password to issue a new one`)
  }
  const path = writePersonaEnv(persona.name, {
    email: account.email, password: account.password, extra,
  })
  return { ...account, envPath: path }
}
