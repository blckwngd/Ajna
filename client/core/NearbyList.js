// NearbyList — Shell-Tab „Objekte": minimalistische Liste der nächstgelegenen
// Objekte. Pro Zeile: Name + Distanz, kleine Beschreibung, 🗺-Link (Karte
// zentrieren) und bis zu drei Interaktions-Buttons (OHNE „Untersuchen" — die
// Beschreibung steht ja direkt daneben).
//
// Update-Strategie (bewusst zweigeteilt, Bedienbarkeit vor Aktualität):
//   • DATEN live: onObjectsChanged aktualisiert Texte/Distanzen/Buttons IN PLACE
//     (gedrosselt) — nichts springt unterm Finger weg.
//   • SORTIERUNG nur bei größeren Änderungen (das Set der Top-N ändert sich,
//     oder der Spieler hat sich > RESORT_MOVE_M bewegt) und spätestens 1×/Minute.
//
// Vorbereiteter Andockpunkt für den späteren „Live"-Modus (Zeige-Selektion wie
// beim Zauberstab): select(objectId) hebt eine Zeile hervor und scrollt sie ins
// Bild — die Zeige-Logik kann das später direkt füttern.

import { renderServerBadge, injectServerBadgeStyles } from './ServerBadge.js'

const MAX_ROWS = 20
const DATA_THROTTLE_MS = 500     // In-Place-Updates bündeln
const RESORT_INTERVAL_MS = 60000 // Sortierung spätestens 1×/Minute
const RESORT_MOVE_M = 25         // …oder wenn der Spieler sich so weit bewegt hat
const R_EARTH = 6378137

const distM = (aLat, aLon, bLat, bLon) => {
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLon = (bLon - aLon) * Math.PI / 180
  const mLat = (aLat + bLat) / 2 * Math.PI / 180
  return Math.hypot(dLon * R_EARTH * Math.cos(mLat), dLat * R_EARTH)
}
const fmtDist = (m) => !Number.isFinite(m) ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
// „Untersuchen" fliegt raus — die Beschreibung steht schon in der Zeile.
const isExamine = (a) => ['examine', 'untersuchen'].includes(String(a?.key || '').toLowerCase())

// Objekt-Typ → Anzeige-Label (Fallback: Roh-Typ). Leerer Typ = kein Badge.
const TYPE_LABELS = {
  npc: 'NPC', enemy: 'Gegner', poi: 'POI', item: 'Item', hint: 'Hinweis',
  dragon: 'Drache', animal: 'Tier', wifi: 'WLAN', ship: 'Schiff',
  aircraft: 'Flugzeug', call: 'Auftrag', uwb_anchor: 'UWB-Anker',
}
const typeLabel = (t) => { const k = String(t || '').toLowerCase(); return k ? (TYPE_LABELS[k] || k) : '' }

export class NearbyList {
  /**
   * @param {{ajna:object, container:HTMLElement, getPosition:()=>({lat:number,lon:number}|null),
   *          actions:object, onShowOnMap:(record)=>void}} opts
   *   actions = ObjectActions-Instanz (actionsFor/trigger — gleiche Quelle wie
   *   Kontextmenü/Quick-Actions, damit die Listen nicht auseinanderlaufen).
   */
  constructor({ ajna, container, getPosition, actions, onShowOnMap, onEdit }) {
    this.ajna = ajna
    this.container = container
    this.getPosition = getPosition
    this.actions = actions
    this.onShowOnMap = onShowOnMap
    this.onEdit = onEdit
    injectServerBadgeStyles()
    this._rows = new Map()        // id → {el, nameEl, distEl, descEl, btnBox, actSig}
    this._order = []              // aktuell dargestellte Reihenfolge (ids)
    this._active = false
    this._unsub = null
    this._dataTimer = null
    this._resortTimer = null
    this._lastSortPos = null
    this._selectedId = null
    this._injectStyles()
    this._buildSkeleton()
  }

  /** Tab sichtbar? Startet/stoppt Subscription + Timer (Akku). */
  setActive(on) {
    if (on === this._active) return
    this._active = on
    if (on) {
      this._unsub = this.ajna.onObjectsChanged(() => this._scheduleData())
      this._resortTimer = setInterval(() => this._resort(), RESORT_INTERVAL_MS)
      this._resort()   // sofort frisch aufbauen
    } else {
      try { this._unsub?.() } catch {}
      this._unsub = null
      clearInterval(this._resortTimer); this._resortTimer = null
      clearTimeout(this._dataTimer); this._dataTimer = null
    }
  }

  /** Andockpunkt für den späteren „Live"-Zeige-Modus: Zeile hervorheben. */
  select(objectId) {
    this._selectedId = objectId || null
    for (const [id, r] of this._rows) r.el.classList.toggle('nb-selected', id === this._selectedId)
    const row = this._rows.get(this._selectedId)
    row?.el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }

  destroy() { this.setActive(false); this.container.replaceChildren() }

  // ── intern ────────────────────────────────────────────────────────────────

  _scheduleData() {
    if (!this._active || this._dataTimer) return
    this._dataTimer = setTimeout(() => { this._dataTimer = null; this._dataTick() }, DATA_THROTTLE_MS)
  }

  /** Top-N nach Distanz (Objekte ohne Position/getragene fliegen raus). */
  _collect() {
    const pos = this.getPosition?.()
    if (!pos || !Number.isFinite(pos.lat)) return { pos: null, list: [] }
    const list = (this.ajna.getObjectList?.() || [])
      .filter(o => o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && !o.carried_by)
      .map(o => ({ o, d: distM(pos.lat, pos.lon, o.lat, o.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ROWS)
    return { pos, list }
  }

  // In-Place-Update: Texte/Distanzen/Buttons der DARGESTELLTEN Zeilen; Struktur
  // (neue/verschwundene Objekte in den Top-N) löst stattdessen ein Resort aus.
  _dataTick() {
    if (!this._active) return
    const { pos, list } = this._collect()
    if (!pos) return this._showEmpty('Warte auf Position …')
    const ids = list.map(e => e.o.id)
    const structural = ids.length !== this._order.length || ids.some(id => !this._rows.has(id))
    const moved = this._lastSortPos && distM(this._lastSortPos.lat, this._lastSortPos.lon, pos.lat, pos.lon) > RESORT_MOVE_M
    if (structural || moved) return this._resort()
    for (const { o, d } of list) this._updateRow(this._rows.get(o.id), o, d)
  }

  /** Kompletter Neuaufbau in sortierter Reihenfolge (Zeilen-Elemente werden
   *  wiederverwendet — appendChild VERSCHIEBT sie nur). */
  _resort() {
    if (!this._active) return
    const { pos, list } = this._collect()
    if (!pos) return this._showEmpty('Warte auf Position …')
    if (!list.length) return this._showEmpty('Keine Objekte in der Nähe.')
    this._emptyEl.hidden = true
    this._lastSortPos = pos
    const keep = new Set(list.map(e => e.o.id))
    for (const [id, r] of this._rows) if (!keep.has(id)) { r.el.remove(); this._rows.delete(id) }
    for (const { o, d } of list) {
      let row = this._rows.get(o.id)
      if (!row) { row = this._buildRow(o); this._rows.set(o.id, row) }
      this._updateRow(row, o, d)
      this._listEl.appendChild(row.el)   // in Sortierreihenfolge (verschiebt)
    }
    this._order = list.map(e => e.o.id)
  }

  /** Besitzer-Check (wie Kontextmenü/Gizmo): Client des Ursprungs-Servers fragen. */
  _isOwner(o) {
    const c = this.ajna.clients?.get(o._origin) || this.ajna.defaultClient
    const me = c?.currentUser?.()
    return !!me && !!o.owner && me.id === o.owner
  }

  _buildRow(o) {
    const el = document.createElement('div')
    el.className = 'nb-row'
    el.dataset.objectId = o.id
    const head = document.createElement('div'); head.className = 'nb-head'
    const nameEl = document.createElement('span'); nameEl.className = 'nb-name'
    const badgeEl = document.createElement('span'); badgeEl.className = 'nb-badges'
    const distEl = document.createElement('span'); distEl.className = 'nb-dist'
    const getRec = () => this.ajna.getObjectById?.(o.id) || o
    // Rechte-abhängige Icon-Buttons (Sichtbarkeit setzt _updateRow pro Update).
    const editBtn = document.createElement('button')
    editBtn.className = 'nb-map'; editBtn.title = 'Bearbeiten'; editBtn.textContent = '✏️'; editBtn.hidden = true
    editBtn.addEventListener('click', () => this.onEdit?.(getRec()))
    const pickBtn = document.createElement('button')
    pickBtn.className = 'nb-map'; pickBtn.title = 'Einsammeln'; pickBtn.textContent = '🎒'; pickBtn.hidden = true
    pickBtn.addEventListener('click', async () => {
      pickBtn.disabled = true
      try { await this.actions?._pickup?.(getRec()) } finally { pickBtn.disabled = false }
    })
    const mapBtn = document.createElement('button')
    mapBtn.className = 'nb-map'; mapBtn.title = 'Auf der Karte zeigen'; mapBtn.textContent = '🗺️'
    mapBtn.addEventListener('click', () => this.onShowOnMap?.(getRec()))
    // Reihenfolge: Einsammeln · Bearbeiten · Karte · Entfernung — die Distanz
    // steht ganz rechts in fester Spaltenbreite, damit alle Zeilen exakt
    // untereinander ausrichten (Icons können je Zeile fehlen).
    head.append(nameEl, pickBtn, editBtn, mapBtn, distEl)
    const descEl = document.createElement('div'); descEl.className = 'nb-desc'
    const btnBox = document.createElement('div'); btnBox.className = 'nb-actions'
    el.append(head, badgeEl, descEl, btnBox)
    if (o.id === this._selectedId) el.classList.add('nb-selected')
    return { el, nameEl, badgeEl, distEl, editBtn, pickBtn, descEl, btnBox, actSig: '', badgeSig: '' }
  }

  _updateRow(row, o, d) {
    if (!row) return
    row.nameEl.textContent = o.name || o.id
    row.distEl.textContent = fmtDist(d)
    // Badges: Typ (NPC/Gegner/…) + Ursprungs-Server (leer bei nur einem Server).
    const tl = typeLabel(o.type)
    const badgeSig = `${tl}|${o._origin || ''}`
    if (badgeSig !== row.badgeSig) {
      row.badgeSig = badgeSig
      row.badgeEl.innerHTML = (tl ? `<span class="nb-type">${tl}</span>` : '') + renderServerBadge(this.ajna, o._origin)
    }
    // Rechte-abhängige Aktionen: Bearbeiten nur als Besitzer; Einsammeln wie im
    // Kontextmenü (eigene immer, fremde nur portable; nie wenn schon getragen).
    const owner = this._isOwner(o)
    row.editBtn.hidden = !owner
    row.pickBtn.hidden = !(!o.carried_by && (owner || !!o.state?.portable))
    const desc = (o.description || '').trim()
    row.descEl.textContent = desc
    row.descEl.hidden = !desc
    // Buttons nur neu bauen, wenn sich die Aktionsliste WIRKLICH ändert —
    // sonst würde ein laufender Finger-Tap ins Leere greifen.
    const acts = (this.actions?.actionsFor?.(o) || []).filter(a => !isExamine(a)).slice(0, 3)
    const sig = acts.map(a => `${a.key}:${a.label}`).join('|')
    if (sig === row.actSig) return
    row.actSig = sig
    row.btnBox.replaceChildren()
    for (const a of acts) {
      const b = document.createElement('button')
      b.className = 'nb-act'
      b.textContent = a.label
      b.addEventListener('click', async () => {
        const rec = this.ajna.getObjectById?.(o.id) || o
        const orig = b.textContent
        b.disabled = true
        try { await this.actions.trigger(rec, a.key); b.textContent = '✓' }
        catch { b.textContent = '✕' }
        setTimeout(() => { b.textContent = orig; b.disabled = false }, 900)
      })
      row.btnBox.appendChild(b)
    }
  }

  _showEmpty(text) {
    this._emptyEl.textContent = text
    this._emptyEl.hidden = false
  }

  _buildSkeleton() {
    this.container.classList.add('nb-container')
    this._emptyEl = document.createElement('div')
    this._emptyEl.className = 'nb-empty'
    this._emptyEl.textContent = 'Warte auf Position …'
    this._listEl = document.createElement('div')
    this._listEl.className = 'nb-list'
    this.container.append(this._emptyEl, this._listEl)
  }

  _injectStyles() {
    if (document.getElementById('nearby-list-style')) return
    const s = document.createElement('style')
    s.id = 'nearby-list-style'
    s.textContent = `
      .nb-container { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
        padding: 10px 10px calc(16px + env(safe-area-inset-bottom, 0px)); box-sizing: border-box; }
      .nb-empty { color: #8a8a94; text-align: center; padding: 32px 12px; font-size: 14px; }
      .nb-row { background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.09);
        border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
      .nb-row.nb-selected { border-color: #7ec8ff; box-shadow: 0 0 0 1px #7ec8ff inset; }
      .nb-head { display: flex; align-items: baseline; gap: 8px; }
      .nb-name { font-weight: 600; font-size: 15px; flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .nb-dist { color: #9ab8d0; font-size: 12px; white-space: nowrap;
        min-width: 56px; text-align: right; }
      .nb-map { background: none; border: none; font-size: 17px; cursor: pointer;
        padding: 0 2px; line-height: 1; }
      .nb-desc { color: #a9a9b2; font-size: 12px; margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .nb-badges { display: block; margin-top: 3px; }
      .nb-badges:empty { display: none; }
      .nb-type { display: inline-block; font-size: 9px; padding: 1px 6px;
        border-radius: 8px; border: 1px solid #6e7c8a; color: #a9b6c2;
        text-transform: uppercase; letter-spacing: 0.05em; line-height: 1.4; }
      .nb-badges .ajna-server-badge:first-child { margin-left: 0; }
      .nb-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .nb-actions:empty { display: none; }
      .nb-act { flex: 1; min-width: 72px; max-width: 160px; padding: 7px 10px;
        font-size: 13px; color: #eaeaea; background: rgba(60,90,130,0.35);
        border: 1px solid rgba(126,200,255,0.35); border-radius: 8px; }
      .nb-act:disabled { opacity: 0.7; }
    `
    document.head.appendChild(s)
  }
}
