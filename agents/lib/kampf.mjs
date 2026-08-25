// kampf — Trefferpunkte, Schaden, Tod und Beute. Für JEDEN Agent.
//
// Der World-Director benutzt das hier, ist aber ausdrücklich nicht der einzige
// Weg: Wer eigene Gegner in die Welt stellen will — ein Rollenspiel-Server, ein
// Betriebsgelände-Szenario, ein Wochenend-Experiment — importiert dieselben
// Funktionen und braucht keinen Director.
//
// WAS HIER NICHT PASSIERT: Kampf ist KEINE Plattformregel. Es gibt dafür keine
// PocketBase-Route und kein Feld im Schema. Treuhand, Rechte und Karma gehören
// ins Basissystem, weil sie über Besitz entscheiden; Trefferpunkte sind eine
// Spielregel, und ein Vereins- oder Firmenserver will vielleicht gar keine
// Gegner. Deshalb steht alles hier, in der Agent-Bibliothek.
//
// WER SCHREIBT DIE ZAHLEN: der BESITZER des Objekts, also der Agent. `state`
// darf sein Besitzer frei schreiben — ein Angreifer kann Trefferpunkte damit
// nicht selbst setzen. Dieselbe Trennlinie wie beim Karma: Eine Zahl, die der
// Client setzen darf, ist keine Zahl, sondern eine Behauptung.
//
// DER ABLAUF
//
//   1. Der Spieler löst `interact(id, 'attack')` aus.
//   2. Der Agent prüft Reichweite (siehe client/core/aktionsReichweite.js) und
//      Abklingzeit — sonst erschlägt ein Skript die halbe Welt aus 10 km.
//   3. Schaden abziehen, `state.hp` schreiben, Treffer-Animation.
//   4. Bei 0: Todes-Animation, Beute AUF DEN BODEN legen, nach ein paar
//      Sekunden löschen.
//   5. Die Soll-Population des Agents lässt anderswo einen neuen entstehen —
//      dafür ist hier nichts zu tun.
//
// BEUTE WIRD ERZEUGT, NICHT GEDECKT. Auftrags-Belohnungen kommen treuhänderisch
// aus einem echten Inventar; Beute entsteht aus dem Nichts. Damit „ein Diamant"
// seine Bedeutung behält, sind Diamanten hier ausdrücklich SELTEN und der Rest
// sind eigene Gattungen — brauchbar als Material für spätere Aufträge
// („bring mir drei Wolfsfelle"), ohne die Auftragswährung zu verwässern.
//
// Die Beute gehört NIEMANDEM: Sie liegt herum und ist tragbar. Das erspart die
// ganze Frage nach Schadensanteilen und Todesstoß und passt zum Weltmodell —
// Dinge liegen in der Gegend.

import { naheGenug, reichweiteVon } from '../../client/core/aktionsReichweite.js'

/** Vorgabe-Trefferpunkte je Archetyp, wenn das Objekt nichts eigenes sagt. */
export const HP_VORGABE = {
  enemy: 30,
  dragon: 120,
  npc: 20,
  animal: 12,
}

/** Schaden eines Schlags ohne eigene Angabe. */
export const SCHADEN_VORGABE = 10

/** Mindestabstand zwischen zwei Schlägen desselben Spielers auf dasselbe Ziel (ms). */
export const ABKLINGZEIT_MS = 1200

/** Wie lange die Leiche liegen bleibt, bevor sie verschwindet (ms). */
export const LIEGEZEIT_MS = 8000

/**
 * Beute-Tabellen je Archetyp.
 *
 * `gewicht` ist relativ innerhalb der Tabelle, `anzahl` die Stückzahl.
 * Diamanten stehen bewusst mit winzigem Gewicht drin: Sie sind
 * Auftragswährung, und was man erschlagen kann, soll sie nicht entwerten.
 *
 * Die übrigen Gattungen sind Material — sie haben für sich keinen Zweck, außer
 * dass ein Auftrag sie später verlangen kann. Genau so ist es gemeint.
 */
export const BEUTE_TABELLEN = {
  enemy: [
    { name: 'Rostige Klinge',   gewicht: 18, anzahl: 1 },
    { name: 'Lederriemen',      gewicht: 22, anzahl: 1 },
    { name: 'Knochensplitter',  gewicht: 25, anzahl: 1 },
    { name: 'Glimmerstein',     gewicht: 12, anzahl: 1 },
    { name: 'Zerfetzter Umhang', gewicht: 10, anzahl: 1 },
    { name: 'Diamant',          gewicht: 1,  anzahl: 1 },
    { name: null,               gewicht: 12 },              // nichts
  ],
  dragon: [
    { name: 'Drachenschuppe',   gewicht: 30, anzahl: 2 },
    { name: 'Aschekristall',    gewicht: 18, anzahl: 1 },
    { name: 'Versengte Kralle', gewicht: 20, anzahl: 1 },
    { name: 'Diamant',          gewicht: 6,  anzahl: 1 },
    { name: null,               gewicht: 6 },
  ],
  animal: [
    { name: 'Wolfsfell',        gewicht: 26, anzahl: 1 },
    { name: 'Federbüschel',     gewicht: 24, anzahl: 1 },
    { name: 'Kräuterbündel',    gewicht: 20, anzahl: 1 },
    { name: null,               gewicht: 30 },
  ],
}

/** Aussehen der Beute — bewusst schlicht, sie liegt auf dem Boden. */
export const BEUTE_AUSSEHEN = {
  'Diamant':          { emoji: '💎', gltf: '/models/Diamond.glb' },
  'Rostige Klinge':   { emoji: '🗡️', color: '#8a6b4a' },
  'Lederriemen':      { emoji: '🪢', color: '#7a5a3a' },
  'Knochensplitter':  { emoji: '🦴', color: '#d8d2c0' },
  'Glimmerstein':     { emoji: '✨', color: '#8fd0e0' },
  'Zerfetzter Umhang':{ emoji: '🧣', color: '#6a4a5a' },
  'Drachenschuppe':   { emoji: '🐲', color: '#3f7a5a' },
  'Aschekristall':    { emoji: '🔮', color: '#8a7a9a' },
  'Versengte Kralle': { emoji: '🪝', color: '#5a4030' },
  'Wolfsfell':        { emoji: '🐺', color: '#8a7a6a' },
  'Federbüschel':     { emoji: '🪶', color: '#e0d8c8' },
  'Kräuterbündel':    { emoji: '🌿', color: '#6a9a4a' },
}

// ── Trefferpunkte ────────────────────────────────────────────────────────

/**
 * Trefferpunkte eines Objekts — mit Ergänzung fehlender Angaben.
 * @returns {{ist: number, max: number}}
 */
export function hpVon(obj) {
  const hp = obj?.state?.hp
  const max = Number(hp?.max) || Number(obj?.state?.hp_max)
    || HP_VORGABE[obj?.state?.archetype] || HP_VORGABE[obj?.type] || HP_VORGABE.enemy
  const ist = Number.isFinite(Number(hp?.ist)) ? Number(hp.ist) : max
  return { ist: Math.max(0, ist), max: Math.max(1, max) }
}

/** Schaden, den ein Schlag auf dieses Objekt macht. */
export function schadenFuer(obj, angabe) {
  const s = Number(angabe ?? obj?.state?.schaden ?? SCHADEN_VORGABE)
  return Number.isFinite(s) && s > 0 ? s : SCHADEN_VORGABE
}

/** Lebt das Objekt noch? Objekte ohne Trefferpunkte gelten als lebendig. */
export function lebt(obj) {
  return hpVon(obj).ist > 0
}

// ── Beute ────────────────────────────────────────────────────────────────

/**
 * Beute auswürfeln.
 *
 * `rnd` ist einspeisbar, damit sich das Ergebnis prüfen lässt — eine
 * Beutetabelle, die man nicht testen kann, ist eine Behauptung über
 * Wahrscheinlichkeiten.
 *
 * @param {object} obj
 * @param {() => number} [rnd]
 * @returns {Array<{name: string, anzahl: number}>}
 */
export function wuerfleBeute(obj, rnd = Math.random) {
  // Am Objekt festgelegte Beute geht vor jeder Tabelle: Ein besonderer Gegner
  // soll etwas Bestimmtes hinterlassen können.
  const fest = obj?.state?.loot
  if (Array.isArray(fest) && fest.length) {
    return fest
      .filter(e => e && e.name && (e.chance == null || rnd() < Number(e.chance)))
      .map(e => ({ name: String(e.name), anzahl: Math.max(1, Number(e.anzahl) || 1) }))
  }

  const tabelle = BEUTE_TABELLEN[obj?.state?.archetype] || BEUTE_TABELLEN[obj?.type]
  if (!tabelle) return []
  const summe = tabelle.reduce((n, e) => n + (Number(e.gewicht) || 0), 0)
  if (summe <= 0) return []
  let wurf = rnd() * summe
  for (const e of tabelle) {
    wurf -= Number(e.gewicht) || 0
    if (wurf <= 0) {
      return e.name ? [{ name: e.name, anzahl: Math.max(1, Number(e.anzahl) || 1) }] : []
    }
  }
  return []
}

/** Datensatz für ein herumliegendes Beutestück. */
export function beuteObjekt(name, { lat, lon, altitude = 0, quelle = null }) {
  const look = BEUTE_AUSSEHEN[name] || { emoji: '📦', color: '#a08a6a' }
  return {
    name,
    type: 'item',
    lat, lon, altitude,
    description: `${name} — liegt hier herum.`,
    // Beschriftung, damit am Boden ERKENNBAR ist, was dort liegt. Ohne sie
    // sieht ein Spieler bloß irgendein Ding und weiß nicht, ob der Gegner
    // überhaupt etwas fallen gelassen hat.
    appearance: { ...look, label: name },
    // `portable` macht es einsammelbar, `realtime` lässt Betrachter das
    // Verschwinden mitbekommen. Kein Besitzer-Anspruch: Wer zuerst kommt.
    state: {
      portable: true, realtime: true, beute: true,
      // Ein Agent-Objekt, das zu KEINER Schicht seines Manifests passt, blendet
      // der Inhaltsfilter aus, sobald ein Spieler dort einmal etwas ausgewählt
      // hat — die Beute wäre dann unsichtbar gefallen. Beute IST ein Item.
      archetype: 'item',
      ...(quelle ? { source: quelle } : {}),
      actions: [{ key: 'examine', label: 'Untersuchen' }],
    },
  }
}

// ── Der Ablauf ───────────────────────────────────────────────────────────

/**
 * Kampf-Zustand eines Agents: Abklingzeiten und liegende Leichen.
 *
 * Bewusst eine Klasse und kein Modul-Zustand — ein Agent kann mehrere Welten
 * oder Server bedienen, und zwei davon sollen sich nicht ins Gehege kommen.
 */
export class Kampf {
  /**
   * @param {{
   *   abklingzeitMs?: number,
   *   liegezeitMs?: number,
   *   rnd?: () => number,
   *   log?: (msg: string) => void,
   * }} [opts]
   */
  constructor({ abklingzeitMs = ABKLINGZEIT_MS, liegezeitMs = LIEGEZEIT_MS,
                rnd = Math.random, log = null } = {}) {
    this.abklingzeitMs = abklingzeitMs
    this.liegezeitMs = liegezeitMs
    this.rnd = rnd
    this.log = log || (() => {})
    this._letzterSchlag = new Map()   // "spieler|ziel" → Zeitpunkt
    this._tot = new Map()             // objektId → Zeitpunkt des Todes
  }

  /** Darf dieser Spieler dieses Ziel jetzt schlagen? */
  darfSchlagen(spielerId, zielId, jetzt = Date.now()) {
    const k = `${spielerId}|${zielId}`
    const letzt = this._letzterSchlag.get(k) || 0
    return (jetzt - letzt) >= this.abklingzeitMs
  }

  /**
   * Einen Angriff auswerten — OHNE zu schreiben.
   *
   * Die Trennung ist Absicht: Diese Funktion rechnet und entscheidet, der
   * Aufrufer schreibt. So lässt sie sich prüfen, ohne einen Server zu starten,
   * und ein Agent kann das Ergebnis anders umsetzen als der World-Director.
   *
   * @param {object} o
   * @param {object} o.ziel        Objekt-Datensatz
   * @param {string} o.angreifer   Konto-Kennung
   * @param {{lat,lon}|null} [o.absender]  mitgeschickte Position (evtl. gerundet)
   * @param {boolean} [o.istNah]   meldet der Nähe-Melder den Spieler hier?
   * @param {number} [o.schaden]
   * @param {number} [o.jetzt]
   * @returns {{ok: boolean, grund: string, hp?: {ist,max}, tot?: boolean,
   *            beute?: Array, text?: string}}
   */
  schlag({ ziel, angreifer, absender = null, istNah = false, schaden = null, jetzt = Date.now() }) {
    if (!ziel?.id) return { ok: false, grund: 'kein-ziel' }
    if (!angreifer) return { ok: false, grund: 'kein-angreifer' }
    if (this._tot.has(ziel.id)) return { ok: false, grund: 'schon-tot' }

    const aktion = (ziel.state?.actions || []).find(a => a?.key === 'attack')
      || { key: 'attack' }
    const nah = naheGenug({
      aktion,
      ziel: { lat: ziel.lat, lon: ziel.lon },
      absender, istNah,
    })
    if (!nah.ok) {
      return {
        ok: false, grund: nah.grund,
        text: nah.grund === 'keine-position'
          ? 'Für einen Angriff muss die Standort-Freigabe mindestens auf „Nähe" stehen.'
          : `Zu weit weg (${Math.round(nah.entfernungM || 0)} m).`,
      }
    }

    if (!this.darfSchlagen(angreifer, ziel.id, jetzt)) {
      return { ok: false, grund: 'zu-schnell', text: 'Noch einen Moment.' }
    }
    this._letzterSchlag.set(`${angreifer}|${ziel.id}`, jetzt)

    const vorher = hpVon(ziel)
    const ab = schadenFuer(ziel, schaden)
    const ist = Math.max(0, vorher.ist - ab)
    const tot = ist <= 0
    const ergebnis = { ok: true, grund: 'treffer', hp: { ist, max: vorher.max }, tot, schaden: ab }
    if (tot) {
      this._tot.set(ziel.id, jetzt)
      ergebnis.beute = wuerfleBeute(ziel, this.rnd)
        .flatMap(e => Array.from({ length: e.anzahl }, () => e.name))
    }
    return ergebnis
  }

  /** Objekte, deren Liegezeit um ist — der Aufrufer löscht sie. */
  abgelaufen(jetzt = Date.now()) {
    const raus = []
    for (const [id, t] of this._tot) {
      if ((jetzt - t) >= this.liegezeitMs) raus.push(id)
    }
    return raus
  }

  /** Ein aufgeräumtes Objekt vergessen. */
  vergiss(id) {
    this._tot.delete(id)
    for (const k of [...this._letzterSchlag.keys()]) {
      if (k.endsWith(`|${id}`)) this._letzterSchlag.delete(k)
    }
  }

  /** Liegt dieses Objekt gerade als Leiche herum? */
  istTot(id) { return this._tot.has(id) }
}

export { naheGenug, reichweiteVon }
