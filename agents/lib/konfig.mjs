// konfig — Betreiber-Einstellungen zur Laufzeit, ohne Neustart.
//
// WOFÜR: Agents laufen als eigene Prozesse. Eine geänderte Env-Variable heißt
// sonst: Prozess neu starten, und zwar jeden einzelnen. Mit einem Datensatz in
// der `settings`-Collection und einem Realtime-Abo wirkt eine Änderung sofort
// und überall gleichzeitig.
//
// DIE REGEL: `.env` liefert die VORGABE, die Datenbank ÜBERSTEUERT sie.
//
// Eine frische Installation läuft damit aus der `.env` allein — es muss nichts
// angelegt werden, bevor irgendetwas startet. Im Betrieb dreht man an der
// Datenbank. Umgekehrt wäre es schlechter: Dann bräuchte jede Neuinstallation
// erst Datensätze.
//
// WAS HIER NICHT HINEINGEHÖRT: Geheimnisse (die Collection ist für jedes
// angemeldete Konto lesbar), alles was VOR PocketBase gebraucht wird, und
// gerätelokale Entscheidungen der Nutzer. Ausführlich in der Migration
// `1787500000_settings.js`.
//
// BENUTZUNG
//
//   import { bootAgent } from './lib/agent-base.mjs'
//   import { Konfig } from './lib/konfig.mjs'
//
//   const { ajna } = await bootAgent('mein-agent')
//   const konf = await Konfig.starte(ajna, { praefix: 'wd' })
//
//   konf.zahl('count.enemy', 'WD_COUNT_ENEMY', 1)   // DB → Env → Vorgabe
//   konf.beiAenderung(() => neuBerechnen())
//
// Gelesen wird IMMER aus dem Speicher — `zahl()` ist synchron und billig genug
// für eine Schleife. Nachgeladen wird über das Abo.

/** Schlüssel, die ein Agent NIE aus der Datenbank lesen sollte. */
const VERBOTEN = /(pass|secret|token|key|credential|_pw$)/i

export class Konfig {
  /**
   * @param {object} ajna     AjnaManager (bereits angemeldet)
   * @param {{praefix?: string, log?: (m: string) => void}} [opts]
   *        praefix: allen Schlüsseln vorangestellt, damit `count.enemy` beim
   *        World-Director nicht mit `count.enemy` eines anderen Agents kollidiert.
   */
  constructor(ajna, { praefix = '', log = null } = {}) {
    this.ajna = ajna
    this.praefix = praefix ? String(praefix).replace(/\.$/, '') + '.' : ''
    this.log = log || ((m) => console.log(`[konfig] ${m}`))
    this._werte = new Map()
    this._hoerer = new Set()
    this._unsub = null
  }

  /** Anlegen, einmal laden, Abo starten. */
  static async starte(ajna, opts = {}) {
    const k = new Konfig(ajna, opts)
    await k.lade()
    await k.abonniere()
    return k
  }

  async lade() {
    try {
      const liste = await this.ajna.pb.collection('settings').getFullList({ sort: 'key' })
      this._werte.clear()
      for (const r of liste) this._werte.set(r.key, r.value)
      if (liste.length) this.log(`${liste.length} Einstellung(en) geladen`)
    } catch (err) {
      // Ein Agent, der ohne Datenbank-Einstellungen nicht startet, wäre ein
      // Rückschritt gegenüber der .env. Fehlt die Collection oder das Recht,
      // gilt eben die Env.
      this.log(`nicht lesbar (${err?.message || err}) — es gilt die .env`)
    }
  }

  async abonniere() {
    if (this._unsub) return
    try {
      this._unsub = await this.ajna.pb.collection('settings').subscribe('*', (e) => {
        const k = e?.record?.key
        if (!k) return
        if (e.action === 'delete') this._werte.delete(k)
        else this._werte.set(k, e.record.value)
        this.log(`"${k}" geändert → ${JSON.stringify(e.record?.value)}`)
        for (const h of this._hoerer) { try { h(k) } catch {} }
      })
    } catch (err) {
      this.log(`Abo fehlgeschlagen (${err?.message || err}) — Änderungen wirken erst beim Neustart`)
    }
  }

  async stoppe() {
    try { await this._unsub?.() } catch {}
    this._unsub = null
    this._hoerer.clear()
  }

  /** Wird bei jeder Änderung gerufen (mit dem Schlüssel). */
  beiAenderung(fn) {
    this._hoerer.add(fn)
    return () => this._hoerer.delete(fn)
  }

  /**
   * Rohwert: Datenbank, sonst Env, sonst Vorgabe.
   * @param {string} name      Schlüssel OHNE Präfix
   * @param {string?} envName  Env-Variable, die dasselbe steuert
   */
  roh(name, envName = null, vorgabe = undefined) {
    const voll = this.praefix + name
    if (this._werte.has(voll)) {
      const v = this._werte.get(voll)
      if (v !== null && v !== undefined && v !== '') return v
    }
    if (envName) {
      if (VERBOTEN.test(envName)) {
        // Nicht versehentlich ein Geheimnis über die Datenbank steuerbar machen.
        return process.env[envName] ?? vorgabe
      }
      const e = process.env[envName]
      if (e !== undefined && e !== '') return e
    }
    return vorgabe
  }

  zahl(name, envName = null, vorgabe = 0) {
    const v = Number(this.roh(name, envName, vorgabe))
    return Number.isFinite(v) ? v : vorgabe
  }

  ganz(name, envName = null, vorgabe = 0) {
    const v = parseInt(this.roh(name, envName, vorgabe), 10)
    return Number.isFinite(v) ? v : vorgabe
  }

  text(name, envName = null, vorgabe = '') {
    const v = this.roh(name, envName, vorgabe)
    return v === undefined || v === null ? vorgabe : String(v)
  }

  jaNein(name, envName = null, vorgabe = false) {
    const v = this.roh(name, envName, vorgabe)
    if (typeof v === 'boolean') return v
    if (v === undefined || v === null || v === '') return vorgabe
    return /^(1|true|yes|on|ja)$/i.test(String(v))
  }

  /** Ganze Struktur (JSON-Wert), z. B. eine Liste. */
  objekt(name, vorgabe = null) {
    const v = this._werte.get(this.praefix + name)
    return v === undefined || v === null ? vorgabe : v
  }

  /** Was gerade aus der Datenbank kommt — für Diagnose-Ausgaben. */
  ausDatenbank() {
    return Object.fromEntries(this._werte)
  }
}
