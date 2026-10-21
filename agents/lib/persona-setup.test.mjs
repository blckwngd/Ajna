import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { ensureAccount, emailFor, randomPassword, writePersonaEnv, runSetup } from './persona-setup.mjs'
import { agentEnvPath } from './env.mjs'

const PERSONA = { name: 'zz-testpersona', figure: { name: 'Test Persona' }, mode: 'basic', prompt: '' }

// A PocketBase stand-in that remembers what was asked of it.
function fakePb(existing = null) {
  const calls = []
  const users = {
    async getFirstListItem(filter) {
      calls.push(['find', filter])
      if (existing) return existing
      const err = new Error('not found'); err.status = 404; throw err
    },
    async create(data) { calls.push(['create', data]); return { id: 'neu1', ...data } },
    async update(id, data) { calls.push(['update', id, data]); return { id, ...existing, ...data } },
  }
  return { calls, collection: (n) => { assert.equal(n, 'users'); return users } }
}

after(() => {
  const p = agentEnvPath('persona-zz-testpersona')
  if (existsSync(p)) rmSync(p)
})

test('a new account is created sealed, verified, with the handle — and not as a guest', async () => {
  const pb = fakePb()
  const r = await ensureAccount(pb, PERSONA)
  assert.equal(r.created, true)
  assert.equal(r.sealed, true)
  assert.equal(r.email, emailFor('zz-testpersona'))
  assert.ok(r.password && r.password.length >= 20)
  const [, data] = pb.calls.find(c => c[0] === 'create')
  assert.equal(data.agent_seal, true)
  assert.equal(data.verified, true)
  assert.equal(data.guest, false)
  assert.equal(data.username, 'zz-testpersona')
  assert.equal(data.name, 'Test Persona')
  assert.equal(data.password, data.passwordConfirm)
})

test('an existing account is found, not duplicated, and its password is left alone', async () => {
  const pb = fakePb({ id: 'alt1', email: emailFor('zz-testpersona'), agent_seal: true, username: 'zz-testpersona', verified: true })
  const r = await ensureAccount(pb, PERSONA)
  assert.equal(r.created, false)
  assert.equal(r.password, null)
  assert.ok(!pb.calls.some(c => c[0] === 'create'))
  assert.ok(!pb.calls.some(c => c[0] === 'update'), 'nothing to repair, nothing written')
})

test('a missing seal or handle is repaired on an existing account', async () => {
  const pb = fakePb({ id: 'alt1', email: emailFor('zz-testpersona'), agent_seal: false, username: '', verified: false })
  const r = await ensureAccount(pb, PERSONA)
  const upd = pb.calls.find(c => c[0] === 'update')
  assert.deepEqual(upd[2], { agent_seal: true, username: 'zz-testpersona', verified: true })
  assert.equal(r.sealed, true)
})

test('resetPassword issues a new one — only when asked', async () => {
  const pb = fakePb({ id: 'alt1', email: emailFor('zz-testpersona'), agent_seal: true, username: 'zz-testpersona', verified: true })
  const r = await ensureAccount(pb, PERSONA, { resetPassword: true })
  assert.ok(r.password)
  const upd = pb.calls.find(c => c[0] === 'update')
  assert.equal(upd[2].password, r.password)
})

test('an invalid name never reaches the server', async () => {
  const pb = fakePb()
  await assert.rejects(() => ensureAccount(pb, { ...PERSONA, name: 'Nicht Gültig' }), /not a valid handle/)
  assert.equal(pb.calls.length, 0)
})

test('randomPassword is long and does not repeat', () => {
  const a = randomPassword(), b = randomPassword()
  assert.ok(a.length >= 20)
  assert.notEqual(a, b)
})

test('the env file keeps what the operator added (the API key must survive a re-run)', () => {
  writePersonaEnv('zz-testpersona', { email: 'a@b', password: 'p1', extra: { ANTHROPIC_API_KEY: 'sk-test' } })
  writePersonaEnv('zz-testpersona', { email: 'a@b', password: null })
  const txt = readFileSync(agentEnvPath('persona-zz-testpersona'), 'utf8')
  assert.match(txt, /ANTHROPIC_API_KEY=sk-test/)
  assert.match(txt, /AJNA_PASS=p1/, 'a null password must not erase the stored one')
  assert.match(txt, /AJNA_USER=a@b/)
})

test('runSetup refuses without superuser credentials, before touching anything', async () => {
  await assert.rejects(() => runSetup(PERSONA, { url: 'http://x', su: '', suPass: '' }), /AJNA_SU/)
})

test('runSetup with a ready client creates the account and writes the file', async () => {
  const pb = fakePb()
  const r = await runSetup(PERSONA, { client: pb, su: 'x', suPass: 'y' })
  assert.equal(r.created, true)
  assert.ok(existsSync(r.envPath))
  assert.match(readFileSync(r.envPath, 'utf8'), /AJNA_USER=persona-zz-testpersona@ajna\.local/)
})
