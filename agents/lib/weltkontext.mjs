// weltkontext.mjs — geteilte Tatsachen über eine Gegend, sprechfertig.
//
// WOFÜR: Damit eine Figur auf mehr reagieren kann als auf ihre eigene
// Koordinate — Wetter, Tageszeit, Mond. Der Entwurf samt Begründungen steht in
// docs/welt-kontext.md; hier ist die Umsetzung.
//
// DIE DREI ENTSCHEIDUNGEN, DIE DEN AUFBAU ERKLÄREN:
//
// 1. ZELLE ALS SCHLÜSSEL, INTERESSENSGEBIET ALS AUSLÖSER. Interessensgebiete
//    leben drei Minuten und verschieben sich, sobald jemand weitergeht — als
//    Schlüssel eines Zwischenspeichers wären sie wertlos, jeder Treffer ginge
//    verloren. Als Auslöser sind sie genau richtig: Geholt wird nur, wo wirklich
//    jemand ist, abgelegt unter einer stabilen Zelle.
//
// 2. DER ZUGRIFF IST SYNCHRON. `varsFuer()` wartet auf nichts. Ein Dialog darf
//    nicht am Netz hängen — er läuft, während ein Spieler auf eine Antwort
//    wartet. Was nicht da ist, fehlt eben; dafür gibt es die Vorgaben.
//
// 3. ABGELAUFEN IST NICHT VORHANDEN. Ein Wetter von vor sechs Stunden ist
//    schlechter als keines: Die Figur behauptet dann etwas Falsches über etwas,
//    das der Spieler selbst sehen kann. Jeder Eintrag trägt seine Gültigkeit.
//
// WAS HIER (NOCH) NICHT IST: die `world_context`-Collection aus dem Entwurf.
// Die wird erst fällig, wenn ein CLIENT die Werte anzeigen soll. Solange nur
// Agents lesen, genügt der Arbeitsspeicher plus `Quellcache` — und der teilt
// seine Dateien über den Quellnamen bereits zwischen Agent-Prozessen.

import { Quellcache } from './quellcache.mjs'

/**
 * Kantenlänge einer Zelle in Grad Breite (~11 km je 0,1°).
 *
 * WARUM SO GROB: Wetter, UV und Luft ändern sich über wenige Kilometer kaum.
 * Ein feineres Raster vervielfacht die Abfragen, ohne dass ein Satz einer Figur
 * dadurch richtiger würde. Und je gröber die Zelle, desto weniger verrät die
 * Abfrage über den, der sie auslöst.
 */
export const ZELLE_GRAD = 0.1

/**
 * Stabile Kennung der Zelle, in der ein Punkt liegt.
 *
 * Bewusst über gerundete Gradwerte statt über ein Geohash: Man kann die Zelle
 * im Log lesen und auf einer Karte wiederfinden.
 *
 * BEKANNTE KANTE: Zwei Punkte, die nur zwei Kilometer auseinanderliegen, können
 * an einer Zellengrenze in verschiedenen Zellen landen. Das kostet eine zweite
 * Abfrage für praktisch dasselbe Wetter und ist hingenommen — ein
 * Nachbarschafts-Suchlauf würde mehr kosten, als er spart.
 */
export function zelleFuer(lat, lon, grad = ZELLE_GRAD) {
  const r = (x) => Math.round(x / grad) * grad
  return `z${r(Number(lat)).toFixed(2)},${r(Number(lon)).toFixed(2)}`
}

/** Mittelpunkt einer Zelle — das ist der Punkt, für den geholt wird. */
export function zellenMitte(zelle) {
  const m = /^z(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(zelle || ''))
  if (!m) return null
  return { lat: Number(m[1]), lon: Number(m[2]) }
}

/**
 * Der Vorrat.
 *
 * Ein Anbieter ist `{ name, ttlMs, hole(ort), abgeleitet? }` und liefert ein
 * Objekt sprechfertiger Werte. Er läuft je Zelle, nicht je Gespräch.
 *
 * `abgeleitet(werte)` ist der Ausweg für alles, was sich SCHNELLER ändert als
 * der Takt: Es wird beim Zugriff gerechnet, nicht beim Holen, und darf eigene
 * Namensräume beisteuern. Tageszeit und Mondphase gehen diesen Weg — sie aus
 * einem Viertelstunden-Vorrat zu bedienen hiesse, dass eine Figur um 19:59
 * „Nachmittag" sagt.
 *
 * @example
 *   const kontext = new Weltkontext({
 *     anbieter: [wetterAnbieter()],
 *     warn: console.warn,
 *   })
 *   await kontext.frischen(['z50.40,7.50'])      // im Takt, für aktive Zellen
 *   const vars = kontext.varsFuer(50.43, 7.46)   // im Gespräch, synchron
 */
export class Weltkontext {
  constructor({ anbieter = [], cache = null, warn = console.warn, jetzt = Date.now } = {}) {
    this.anbieter = anbieter
    this.warn = warn
    this.jetzt = jetzt
    // Zwischenspeicher auf Platte. WOFÜR ZWEIMAL SPEICHERN: Die Karte im
    // Arbeitsspeicher überlebt keinen Neustart — und gerade die Entwicklung
    // startet einen Agenten zwanzigmal am Tag. Der Quellcache teilt seine
    // Dateien ausserdem über den Quellnamen, also auch zwischen zwei
    // Agent-Prozessen: Director und POI-Bridge fragen dasselbe Wetter einmal.
    // `false` schaltet ihn ab (Tests).
    this.cache = cache === null
      ? new Quellcache('weltkontext', { ttlMs: 15 * 60_000, log: () => {} })
      : cache
    /** @type {Map<string, {werte: object, bis: number}>} zelle:anbieter → Eintrag */
    this.eintraege = new Map()
    this.laufend = new Set()
  }

  _schluessel(zelle, anbieter) { return `${zelle}|${anbieter.name}` }

  /** Ist für diese Zelle und diesen Anbieter etwas GÜLTIGES da? */
  hatFrisches(zelle, anbieter) {
    const e = this.eintraege.get(this._schluessel(zelle, anbieter))
    return !!e && e.bis > this.jetzt()
  }

  /**
   * Holen, was fehlt oder abgelaufen ist — für genau diese Zellen.
   *
   * Der Aufrufer bestimmt die Menge; sinnvoll ist der Schnitt aus aktiven
   * Interessensgebieten und Zellen, in denen der Agent eigene Figuren hat.
   * Wo niemand steht, hört niemand zu; wo der Agent keine Figur hat, muss er
   * nichts wissen.
   *
   * Fehler eines Anbieters werden gewarnt, nicht geworfen: Ein Wetterdienst,
   * der schweigt, darf keine Figur zum Verstummen bringen. Der alte Wert bleibt
   * stehen, bis er abläuft — danach fehlt das Wetter, und die Figur sagt eben
   * nichts darüber.
   */
  async frischen(zellen) {
    const arbeit = []
    for (const zelle of new Set(zellen)) {
      const ort = zellenMitte(zelle)
      if (!ort) continue
      for (const a of this.anbieter) {
        const k = this._schluessel(zelle, a)
        if (this.hatFrisches(zelle, a) || this.laufend.has(k)) continue
        this.laufend.add(k)
        arbeit.push(this._holen(zelle, ort, a, k))
      }
    }
    if (arbeit.length) await Promise.all(arbeit)
    return arbeit.length
  }

  async _holen(zelle, ort, anbieter, k) {
    const ttl = anbieter.ttlMs || 900_000
    try {
      const werte = this.cache
        ? (await this.cache.hole(k, () => anbieter.hole(ort), { ttlMs: ttl })).daten
        : await anbieter.hole(ort)
      if (werte && typeof werte === 'object') {
        this.eintraege.set(k, { werte, bis: this.jetzt() + ttl })
      }
    } catch (err) {
      this.warn(`[weltkontext] ${anbieter.name} für ${zelle}: ${err?.message || err}`)
    } finally {
      this.laufend.delete(k)
    }
  }

  /**
   * Die Variablen für einen Ort — SYNCHRON, ohne Netz, ohne Warten.
   *
   * Namensraum je Anbieter (`wetter.*`), damit zwei Quellen sich nicht
   * gegenseitig überschreiben und ein Dialog sieht, woher ein Wert kommt.
   */
  varsFuer(lat, lon) {
    const zelle = zelleFuer(lat, lon)
    const raus = {}
    for (const a of this.anbieter) {
      const e = this.eintraege.get(this._schluessel(zelle, a))
      if (!e || e.bis <= this.jetzt()) continue   // abgelaufen = nicht vorhanden
      raus[a.name] = { ...e.werte }
      if (typeof a.abgeleitet === 'function') {
        try { Object.assign(raus, a.abgeleitet(e.werte)) }
        catch (err) { this.warn(`[weltkontext] ${a.name}.abgeleitet: ${err?.message || err}`) }
      }
    }
    return raus
  }

  /** Abgelaufene Einträge wegräumen — sonst wächst die Karte mit jeder Zelle. */
  aufraeumen() {
    const jetzt = this.jetzt()
    let weg = 0
    for (const [k, e] of this.eintraege) {
      if (e.bis <= jetzt) { this.eintraege.delete(k); weg++ }
    }
    return weg
  }

  /** Wie viele Zellen halten gerade gültige Werte? (fürs Log) */
  get bestand() {
    const jetzt = this.jetzt()
    let n = 0
    for (const e of this.eintraege.values()) if (e.bis > jetzt) n++
    return n
  }
}
