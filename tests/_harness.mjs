// Gemeinsamer Harness für die Quest-/Handels-E2E-Tests.
//
// WARUM E2E gegen eine laufende Instanz: die Quest-Logik sitzt in den
// PocketBase-Hooks (`pb_hooks/quests.js` + die quest/*-Routen). Deren Verhalten
// — Treuhand-Deckung, atomarer Tausch, Status-Übergänge — lässt sich nur über
// echte HTTP-Aufrufe prüfen; `node --check` sieht davon nichts, und Goja bricht
// erst zur Laufzeit.
//
// Voraussetzung: der Stack läuft (`npm run stack`).
//
// Der Harness legt Wegwerf-Nutzer/-Objekte an und räumt sie hinterher weg.
// Wichtig beim Aufräumen: durch den Tausch WECHSELT der Besitz — deshalb wird
// jeder bekannte Token durchprobiert. Sonst bleiben verwaiste Zeilen liegen
// (genau das ist beim ersten manuellen Lauf einmal passiert).

const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'
const PW = process.env.AJNA_TEST_PW || 'qtest-pw-12345'

export async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(PB + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* 204 o. ä. — kein Body */ }
  return { status: res.status, data }
}

/** Ist die Instanz erreichbar? Sonst liefen alle Suiten sinnlos rot. */
export async function reachable() {
  try { return (await req('/api/health')).status === 200 } catch { return false }
}

/**
 * Test-Kontext: Helfer + Prüfungen + automatisches Aufräumen.
 * @param {string} prefix eindeutig je Suite (fließt in die Wegwerf-E-Mails)
 */
export function createContext(prefix) {
  const users = []      // { id, token, email }
  const objects = []    // Objekt-IDs in Anlage-Reihenfolge
  const passed = []
  const failed = []

  return {
    passed, failed,

    check(name, cond, info = '') {
      ;(cond ? passed : failed).push(name + (info ? ` — ${info}` : ''))
      console.log(`   ${cond ? '✅' : '❌'} ${name}${info ? ` — ${info}` : ''}`)
      return !!cond
    },

    /** Wegwerf-Nutzer anlegen + einloggen (`name` ist Pflichtfeld der Collection). */
    async user(tag) {
      const email = `${prefix}-${tag}@example.invalid`
      await req('/api/collections/users/records', {
        method: 'POST',
        body: { email, password: PW, passwordConfirm: PW, name: `${prefix}-${tag}` },
      })
      const r = await req('/api/collections/users/auth-with-password', {
        method: 'POST', body: { identity: email, password: PW },
      })
      if (!r.data?.token) throw new Error(`Login fehlgeschlagen (${email}): ${JSON.stringify(r.data)}`)
      const u = { id: r.data.record.id, token: r.data.token, email }
      users.push(u)
      return u
    },

    async object(token, data) {
      const r = await req('/api/collections/objects/records', { method: 'POST', token, body: data })
      if (!r.data?.id) throw new Error(`Objekt anlegen fehlgeschlagen: ${JSON.stringify(r.data)}`)
      objects.push(r.data.id)
      return r.data
    },

    /** Kurzform: tragbares Item an einer Standardposition. */
    item(token, name) {
      return this.object(token, { name, type: 'item', lat: 50.4466, lon: 7.5971, altitude: 0, state: { portable: true } })
    },

    /** Kurzform: Auftrag mit Aufgabe, offen. */
    call(token, name, task = 'Testaufgabe') {
      return this.object(token, {
        name, type: 'call', lat: 50.4466, lon: 7.5971, altitude: 0,
        state: { call: { task, status: 'open' } },
      })
    },

    carry: (token, id) => req(`/api/objects/${id}/pickup`, { method: 'POST', token, body: {} }),
    place: (token, id, pos = { lat: 50.4, lon: 7.5 }) => req(`/api/objects/${id}/place`, { method: 'POST', token, body: pos }),

    /** Objekt für alle Angemeldeten sichtbar machen (view) — sonst sieht der Spieler den Auftrag nicht. */
    share: (token, id) => req('/api/collections/object_permissions/records', {
      method: 'POST', token,
      body: { object: id, subject_type: 'authenticated', rights: ['view'], interact_actions: [] },
    }),

    /** Record frisch lesen — MIT DEM TOKEN, der ihn sehen darf (nach dem Tausch der neue Besitzer!). */
    read: async (token, id) => (await req(`/api/collections/objects/records/${id}`, { token })).data,
    /** Rohe Record-Änderung — simuliert „Speichern" aus dem Editor. */
    patch: (token, id, body) => req(`/api/collections/objects/records/${id}`, { method: 'PATCH', token, body }),
    /**
     * Änderung am EIGENEN Nutzerdatensatz. Gebraucht für Felder, die der Server
     * schützt (agent_seal, karma_points): Der Test muss den Versuch machen
     * dürfen, um zu sehen, dass er folgenlos bleibt.
     */
    patchUser: (token, id, body) =>
      req(`/api/collections/users/records/${id}`, { method: 'PATCH', token, body }),
    /** Beliebiger API-Aufruf — für Collections ohne eigenen Helfer (z. B. groups). */
    raw: (path, opts = {}) => req(path, opts),
    /** Eigenen Nutzerdatensatz lesen. */
    readUser: async (token, id) =>
      (await req(`/api/collections/users/records/${id}`, { token })).data,
    /**
     * Objekt löschen (für Tests, die das Verwaisen der Treuhand provozieren).
     * Nimmt es aus der Aufräum-Liste — sonst meldete cleanup() es später als
     * „nicht entfernbar" (404), obwohl der Test es absichtlich beseitigt hat.
     */
    async del(token, id) {
      const r = await req(`/api/collections/objects/records/${id}`, { method: 'DELETE', token })
      if (r.status < 400) {
        const i = objects.indexOf(id)
        if (i !== -1) objects.splice(i, 1)
      }
      return r
    },

    quest: {
      publish:  (token, id, body) => req(`/api/objects/${id}/quest/publish`,  { method: 'POST', token, body }),
      accept:   (token, id) => req(`/api/objects/${id}/quest/accept`,   { method: 'POST', token, body: {} }),
      complete: (token, id, body = {}) => req(`/api/objects/${id}/quest/complete`, { method: 'POST', token, body }),
      cancel:   (token, id) => req(`/api/objects/${id}/quest/cancel`,   { method: 'POST', token, body: {} }),
      approve:  (token, id, body = {}) => req(`/api/objects/${id}/quest/approve`, { method: 'POST', token, body }),
      reject:   (token, id, body = {}) => req(`/api/objects/${id}/quest/reject`,  { method: 'POST', token, body }),
      confirm:  (token, id, body = { verdict: 'ok' }) =>
        req(`/api/objects/${id}/quest/confirm`, { method: 'POST', token, body }),
      /** Regionsliste — was sehe ICH hier an Aufträgen? */
      near: (token, params = {}) => {
        const q = new URLSearchParams(params).toString()
        return req(`/api/quests/near${q ? '?' + q : ''}`, { token })
      },
    },

    /** Objekte zuerst, dann Nutzer. Besitz kann gewechselt haben → alle Tokens durchprobieren. */
    async cleanup() {
      let left = 0
      for (const id of [...objects].reverse()) {
        let deleted = false
        let allMissing = true   // meldeten ALLE 404, ist es wirklich weg
        for (const u of users) {
          const s = (await req(`/api/collections/objects/records/${id}`, { method: 'DELETE', token: u.token })).status
          if (s < 400) { deleted = true; break }
          // 404 heißt nur „für DIESEN Nutzer nicht sichtbar" — ein anderer kann
          // es nach dem Tausch trotzdem besitzen, also weiterprobieren.
          if (s !== 404) allMissing = false
        }
        if (!deleted && !allMissing) left++
      }
      for (const u of users) await req(`/api/collections/users/records/${u.id}`, { method: 'DELETE', token: u.token })
      return left
    },
  }
}
