// quellcache — fremde APIs abfragen, ohne ihr Kontingent zu verbrennen.
//
// WOFÜR: Jede externe Quelle in Ajna (WiGLE, Overpass, OpenSky, aisstream …)
// hat dieselben vier Probleme, und bisher löst sie jeder Agent für sich neu —
// meist unvollständig:
//
//   1. ZWISCHENSPEICHER auf Platte. Ohne ihn beginnt jeder Neustart bei null.
//      Genau das ist die häufigste Art, ein Tageslimit zu verbrennen: nicht der
//      Dauerbetrieb, sondern zehn Neustarts während der Entwicklung.
//   2. ALTES AUSLIEFERN, wenn die Quelle nicht antwortet. Eine zwölf Stunden
//      alte Antwort ist fast immer besser als gar keine — sie muss nur als alt
//      gekennzeichnet sein.
//   3. BUDGET. Ein Mindestabstand zwischen Abfragen und eine Obergrenze pro
//      Tag. Beides muss die Laufzeit ÜBERDAUERN, sonst zählt jeder Neustart
//      wieder von vorn.
//   4. BÜNDELN. Zwei gleichzeitige Aufrufer derselben Frage sind eine Abfrage,
//      nicht zwei.
//
// Serverseitig steht dasselbe Muster in `server/geo.js` (Overpass). Diese
// Fassung ist die für Agents: ohne Express, ohne Bezug auf Ajna, nur Dateisystem.
//
// NICHT ENTHALTEN: Wiederholversuche mit Backoff bei Netzfehlern. Das ist eine
// andere Entscheidung — eine Quelle, die gerade nicht antwortet, soll aus dem
// Zwischenspeicher bedient werden, nicht mit Nachdruck erneut gefragt werden.
//
// BENUTZUNG
//
//   const cache = new Quellcache('wigle', {
//     ttlMs: 12 * 3600_000,
//     minAbstandMs: 60_000,
//     proTag: 100,
//   })
//
//   const { daten, herkunft } = await cache.hole('bbox:50.4,7.5', () => fetchWigle(...))
//   //  herkunft: 'frisch' | 'cache' | 'cache-alt' | null (Budget aufgebraucht)
//
// Der Aufrufer entscheidet, was ein Schlüssel ist. Er sollte alles enthalten,
// was die Antwort verändert (Bereich, Filter, Auflösung) — und NICHTS, was sich
// bei jedem Aufruf ändert, sonst trifft der Zwischenspeicher nie.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HIER = dirname(fileURLToPath(import.meta.url))

/** Vorgabe-Ort für die Ablage: <repo>/.cache/agents/<name>. */
export const cacheWurzel = (name) => join(HIER, '..', '..', '.cache', 'agents', name)

const jetzt = () => Date.now()
const tagesStempel = (t = jetzt()) => new Date(t).toISOString().slice(0, 10)

export class Quellcache {
  /**
   * @param {string} name  Kennung der Quelle (bestimmt den Ablageort)
   * @param {{
   *   ttlMs?: number,          Wie lange eine Antwort als frisch gilt
   *   minAbstandMs?: number,   Mindestabstand zwischen zwei echten Abfragen
   *   proTag?: number,         Obergrenze echter Abfragen je Kalendertag (0 = keine)
   *   maxDateien?: number,     Obergrenze der abgelegten Antworten
   *   dir?: string,            Ablageort (sonst Vorgabe)
   *   log?: (msg: string) => void,
   * }} [opts]
   */
  constructor(name, {
    ttlMs = 12 * 3600_000,
    minAbstandMs = 0,
    proTag = 0,
    maxDateien = 2000,
    dir = null,
    log = null,
  } = {}) {
    this.name = name
    this.ttlMs = ttlMs
    this.minAbstandMs = minAbstandMs
    this.proTag = proTag
    this.maxDateien = maxDateien
    this.dir = dir || cacheWurzel(name)
    this.log = log || ((m) => console.log(`[${name}:cache] ${m}`))

    this._speicher = new Map()     // Schlüssel → {ts, daten}
    this._laufend = new Map()      // Schlüssel → Versprechen
    this._budget = null            // {tag, benutzt, letzte, gesperrtBis}
    this._budgetGeladen = null
  }

  // ── Budget ─────────────────────────────────────────────────────────────

  get _budgetDatei() { return join(this.dir, '_budget.json') }

  async _ladeBudget() {
    if (this._budget) return this._budget
    if (!this._budgetGeladen) {
      this._budgetGeladen = (async () => {
        let b = null
        try { b = JSON.parse(await readFile(this._budgetDatei, 'utf8')) } catch { b = null }
        const heute = tagesStempel()
        // Ein Zähler vom Vortag ist kein Zähler mehr. Das Datum mitzuführen ist
        // billiger und ehrlicher als eine Mitternachts-Uhr.
        this._budget = (b && b.tag === heute)
          ? { tag: heute, benutzt: Number(b.benutzt) || 0, letzte: Number(b.letzte) || 0, gesperrtBis: Number(b.gesperrtBis) || 0 }
          : { tag: heute, benutzt: 0, letzte: Number(b?.letzte) || 0, gesperrtBis: Number(b?.gesperrtBis) || 0 }
        return this._budget
      })()
    }
    return this._budgetGeladen
  }

  async _schreibeBudget() {
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this._budgetDatei, JSON.stringify(this._budget), 'utf8')
    } catch (err) { /* Ablage ist Bequemlichkeit, kein Muss */ }
  }

  /**
   * Darf jetzt eine echte Abfrage laufen?
   * @returns {Promise<{ok: boolean, grund?: string, wartenMs?: number}>}
   */
  async darfAbfragen() {
    const b = await this._ladeBudget()
    const t = jetzt()
    if (b.tag !== tagesStempel(t)) { b.tag = tagesStempel(t); b.benutzt = 0 }

    if (b.gesperrtBis > t) {
      return { ok: false, grund: 'gesperrt', wartenMs: b.gesperrtBis - t }
    }
    if (this.proTag > 0 && b.benutzt >= this.proTag) {
      return { ok: false, grund: 'tageslimit', wartenMs: null }
    }
    if (this.minAbstandMs > 0 && b.letzte && (t - b.letzte) < this.minAbstandMs) {
      return { ok: false, grund: 'zu-frueh', wartenMs: this.minAbstandMs - (t - b.letzte) }
    }
    return { ok: true }
  }

  /** Eine verbrauchte Abfrage buchen. */
  async buche(n = 1) {
    const b = await this._ladeBudget()
    b.benutzt += n
    b.letzte = jetzt()
    await this._schreibeBudget()
  }

  /**
   * Die Quelle hat abgeriegelt (429 o. ä.) — bis auf Weiteres nicht fragen.
   *
   * Ohne diese Sperre liefe der Agent in eine Schleife aus Ablehnungen; manche
   * Anbieter werten schon die abgelehnten Versuche als Last.
   */
  async sperre(dauerMs = 3600_000) {
    const b = await this._ladeBudget()
    b.gesperrtBis = jetzt() + dauerMs
    await this._schreibeBudget()
    this.log(`Quelle gesperrt für ${Math.round(dauerMs / 60000)} min`)
  }

  /** Auskunft für Protokoll und Statusanzeige. */
  async stand() {
    const b = await this._ladeBudget()
    return {
      tag: b.tag,
      benutzt: b.benutzt,
      uebrig: this.proTag > 0 ? Math.max(0, this.proTag - b.benutzt) : null,
      gesperrt: b.gesperrtBis > jetzt() ? new Date(b.gesperrtBis).toISOString() : null,
    }
  }

  // ── Ablage ─────────────────────────────────────────────────────────────

  _datei(schluessel) {
    return join(this.dir, createHash('sha1').update(String(schluessel)).digest('hex') + '.json')
  }

  async _lies(schluessel) {
    const s = this._speicher.get(schluessel)
    if (s) return s
    try {
      const e = JSON.parse(await readFile(this._datei(schluessel), 'utf8'))
      if (e && typeof e.ts === 'number') { this._speicher.set(schluessel, e); return e }
    } catch { /* nichts abgelegt */ }
    return null
  }

  async _schreibe(schluessel, daten) {
    const e = { ts: jetzt(), schluessel, daten }
    this._speicher.set(schluessel, e)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this._datei(schluessel), JSON.stringify(e), 'utf8')
    } catch (err) {
      this.log(`Ablegen fehlgeschlagen: ${err?.message || err}`)
    }
    this._aufraeumenSpaeter()
  }

  // ── Der eigentliche Zugriff ────────────────────────────────────────────

  /**
   * Antwort holen — aus der Ablage oder von der Quelle.
   *
   * @param {string} schluessel
   * @param {() => Promise<any>} abfragen  ruft die Quelle; wirft bei Fehlern
   * @param {{frisch?: boolean, ttlMs?: number, kosten?: number}} [opts]
   *        `frisch: true` erzwingt eine Abfrage (Budget gilt trotzdem).
   * @returns {Promise<{daten: any, herkunft: 'frisch'|'cache'|'cache-alt'|null,
   *                    alterMin?: number, grund?: string}>}
   */
  async hole(schluessel, abfragen, { frisch = false, ttlMs = this.ttlMs, kosten = 1 } = {}) {
    const laufend = this._laufend.get(schluessel)
    if (laufend) return laufend

    const arbeit = (async () => {
      const abgelegt = await this._lies(schluessel)
      const alter = abgelegt ? jetzt() - abgelegt.ts : Infinity

      if (!frisch && abgelegt && alter < ttlMs) {
        return { daten: abgelegt.daten, herkunft: 'cache', alterMin: Math.round(alter / 60000) }
      }

      const darf = await this.darfAbfragen()
      if (!darf.ok) {
        // Budget aufgebraucht: lieber etwas Altes als nichts. Der Aufrufer
        // erfährt an `herkunft`, woran er ist.
        if (abgelegt) {
          return { daten: abgelegt.daten, herkunft: 'cache-alt',
                   alterMin: Math.round(alter / 60000), grund: darf.grund }
        }
        return { daten: null, herkunft: null, grund: darf.grund }
      }

      try {
        const daten = await abfragen()
        await this.buche(kosten)
        await this._schreibe(schluessel, daten)
        return { daten, herkunft: 'frisch' }
      } catch (err) {
        // Der Versuch hat gezählt, auch wenn er scheiterte — bei den meisten
        // Anbietern zählt die ANFRAGE, nicht die gelungene Antwort.
        await this.buche(kosten)
        if (abgelegt) {
          this.log(`Quelle fehlgeschlagen (${err?.message || err}) → alte Antwort, ${Math.round(alter / 60000)} min`)
          return { daten: abgelegt.daten, herkunft: 'cache-alt',
                   alterMin: Math.round(alter / 60000), grund: String(err?.message || err) }
        }
        throw err
      }
    })()

    this._laufend.set(schluessel, arbeit)
    try { return await arbeit } finally { this._laufend.delete(schluessel) }
  }

  // ── Aufräumen ──────────────────────────────────────────────────────────

  _aufraeumenSpaeter() {
    if (this._raeumt) return
    this._raeumt = true
    setTimeout(() => { this._raeumt = false; this.aufraeumen().catch(() => {}) }, 30_000).unref?.()
  }

  /** Älteste Antworten wegwerfen, wenn zu viele abgelegt sind. */
  async aufraeumen() {
    if (!this.maxDateien) return
    let dateien = []
    try { dateien = (await readdir(this.dir)).filter(f => f.endsWith('.json') && f !== '_budget.json') }
    catch { return }
    if (dateien.length <= this.maxDateien) return
    const mit = []
    for (const f of dateien) {
      try { mit.push({ f, t: (await stat(join(this.dir, f))).mtimeMs }) } catch {}
    }
    mit.sort((a, b) => a.t - b.t)
    for (const { f } of mit.slice(0, mit.length - this.maxDateien)) {
      try { await unlink(join(this.dir, f)) } catch {}
    }
  }
}

/**
 * Ist das eine Abfuhr wegen Überlastung/Kontingent?
 *
 * Anbieter melden das uneinheitlich: mal als Statuscode, mal als 200 mit einem
 * Vermerk im Rumpf. Deshalb beides prüfen — wer nur auf 429 hört, läuft bei
 * WiGLE ins Leere.
 */
export function istAbgeriegelt(fehlerOderAntwort) {
  const s = String(fehlerOderAntwort?.message || fehlerOderAntwort || '')
  if (/\b429\b/.test(s)) return true
  return /too many|rate.?limit|quota|limit erreicht|exceeded|throttl/i.test(s)
}
