// FriendsDialog — die Freundesliste: ein schwebender Knopf (👥 mit Zähler
// offener Einladungen) und ein Fenster mit vier Abschnitten.
//
//   Einladungen an dich     annehmen / ablehnen
//   Freunde                 Gespräch starten / entfernen
//   Gesendete Einladungen   zurückziehen
//   Freund hinzufügen       Handle oder E-Mail eintippen — oder jemanden
//                           nehmen, der gerade in der Nähe steht
//
// WAS EINE FREUNDSCHAFT IST: das Konto als Gegenüber für den Chat, auch wenn
// es nicht in der Nähe ist. Mehr nicht — keine Position, kein Zugriff. Der
// Transport steht (`sendChat`, Postfach für Abwesende); hier fehlt nur der
// Weg, ein Konto zu WÄHLEN. Deshalb ist „Gespräch" der wichtigste Knopf.
//
// Anzeigenamen kommen aus den Zeilen selbst (vom Server gestempelt): Ein
// Konto darf fremde Nutzer nicht lesen. Dieselbe Quelle bedient
// `nameFor(userId)` für das Chatfenster, damit eine Nachricht eines Freundes
// seinen Namen trägt statt seiner Kennung.

import { t } from './i18n.js'
import { klickDaneben } from './klickDaneben.js'
import { getFabBar } from './FabBar.js'
import { Toast } from './Toast.js'

const STYLE_ID = 'ajna-friends-style'

export class FriendsDialog {
  /**
   * @param {{ajna: import('./AjnaManager.js').AjnaManager, toast?: Toast, logPanel?: object}} opts
   */
  constructor({ ajna, toast = null, logPanel = null } = {}) {
    this.ajna = ajna
    this._toast = toast || new Toast()
    this._logPanel = logPanel
    this._rows = []
    this._backdrop = null
    this._unsub = null
    this._injectStyles()
    this._launcher = getFabBar().createLauncher({
      id: 'friends', label: 'Freunde', emoji: '👥', hotkey: 'e',
      onClick: () => this.toggle(),
    })
    this._badge = document.createElement('span')
    this._badge.className = 'ajna-friends-badge'
    this._badge.hidden = true
    this._launcher.el.appendChild(this._badge)
    this._subscribe()
  }

  // ── Daten ──────────────────────────────────────────────────────────────

  get me() { return this.ajna.currentUser?.()?.id || null }

  /** Anzeigename eines Kontos, falls es ein Freund (oder Einladender) ist. */
  nameFor(userId) {
    const id = String(userId || '')
    for (const f of this._rows) {
      if (String(f.from) === id && f.from_name) return f.from_name
      if (String(f.to) === id && f.to_name) return f.to_name
    }
    return null
  }

  /** Angenommene Freundschaften als { id, userId, name }. */
  friends() {
    const me = this.me
    return this._rows.filter(f => f.status === 'accepted').map(f => {
      const other = String(f.from) === me
      return { id: f.id, userId: other ? f.to : f.from, name: (other ? f.to_name : f.from_name) || (other ? f.to : f.from) }
    })
  }

  incoming() { const me = this.me; return this._rows.filter(f => f.status === 'invited' && String(f.to) === me) }
  outgoing() { const me = this.me; return this._rows.filter(f => f.status === 'invited' && String(f.from) === me) }

  async _reload() {
    try { this._rows = await this.ajna.listFriendships() } catch { this._rows = [] }
    this._updateBadge()
    if (this._backdrop) this._render()
  }

  async _subscribe() {
    let lauf = 0
    const abo = async () => {
      const meiner = ++lauf
      try { this._unsub?.() } catch {}
      this._unsub = null
      if (!this.ajna.isLoggedIn?.()) { this._rows = []; this._updateBadge(); return }
      await this._reload()
      try {
        const off = await this.ajna.onFriendshipsChanged((e) => this._onChange(e))
        if (meiner !== lauf) { try { off() } catch {}; return }
        this._unsub = off
      } catch (err) { console.warn('[friends] Abo fehlgeschlagen:', err?.message || err) }
    }
    abo()
    this.ajna.onAuthChanged?.(() => abo())
  }

  _onChange(e) {
    const vorher = this.incoming().length
    this._reload().then(() => {
      // Eine neue Einladung sagt sich selbst an — der Zähler allein wird
      // übersehen, und wer eingeladen wird, soll es erfahren, nicht finden.
      if (e?.action === 'create' && String(e.record?.to) === this.me && this.incoming().length > vorher) {
        this._toast.show(t('{name} möchte mit dir befreundet sein.').replace('{name}', e.record.from_name || t('Jemand')),
          { title: t('Freunde'), log: false, onClick: () => this.open() })
      }
      if (e?.action === 'update' && e.record?.status === 'accepted' && String(e.record?.from) === this.me) {
        this._toast.show(t('{name} hat deine Einladung angenommen.').replace('{name}', e.record.to_name || t('Jemand')),
          { title: t('Freunde'), log: false, onClick: () => this.open() })
      }
    })
  }

  _updateBadge() {
    const n = this.incoming().length
    this._badge.hidden = n === 0
    this._badge.textContent = n > 99 ? '99+' : String(n)
  }

  // ── Fenster ────────────────────────────────────────────────────────────

  toggle() { this._backdrop ? this.close() : this.open() }

  async open() {
    if (this._backdrop) return
    if (!this.ajna.isLoggedIn?.()) {
      this._toast.show(t('Bitte anmelden — Freunde gehören zu einem Konto.'), { title: t('Freunde') })
      return
    }
    const bd = document.createElement('div')
    bd.className = 'ajna-friends-backdrop'
    bd.innerHTML = `
      <div class="ajna-friends" role="dialog" aria-modal="true" aria-label="${t('Freunde')}">
        <header><h3>${t('Freunde')}</h3><button class="fd-close" type="button" aria-label="${t('Schließen')}">×</button></header>
        <section data-sec="incoming"><h4>${t('Einladungen an dich')}</h4><div class="fd-list"></div></section>
        <section data-sec="friends"><h4>${t('Freunde')}</h4><div class="fd-list"></div></section>
        <section data-sec="outgoing"><h4>${t('Gesendete Einladungen')}</h4><div class="fd-list"></div></section>
        <section data-sec="add"><h4>${t('Freund hinzufügen')}</h4>
          <form class="fd-add"><input type="text" data-role="q" autocomplete="off" placeholder="${t('Handle oder E-Mail')}" maxlength="200">
            <button type="submit">${t('Einladen')}</button></form>
          <div class="fd-status" data-role="status" hidden></div>
          <div class="fd-near"><div class="fd-near-title">${t('In der Nähe')}</div><div class="fd-list" data-role="near"></div></div>
        </section>
      </div>`
    document.body.appendChild(bd)
    this._backdrop = bd
    bd.querySelector('.fd-close').addEventListener('click', () => this.close())
    klickDaneben(bd, () => this.close())
    bd.querySelector('.fd-add').addEventListener('submit', (ev) => {
      ev.preventDefault()
      const q = bd.querySelector('[data-role="q"]').value.trim()
      if (q) this._inviteByQuery(q)
    })
    this._render()
    await this._reload()
  }

  close() {
    this._backdrop?.remove()
    this._backdrop = null
  }

  _render() {
    const bd = this._backdrop
    if (!bd) return
    const me = this.me
    const list = (sec) => bd.querySelector(`[data-sec="${sec}"] .fd-list`)
    const leer = (el, text) => { el.innerHTML = `<div class="fd-empty">${text}</div>` }
    const row = (name, hint, buttons) => {
      const r = document.createElement('div')
      r.className = 'fd-row'
      const n = document.createElement('span'); n.className = 'fd-name'; n.textContent = name
      r.appendChild(n)
      if (hint) { const h = document.createElement('span'); h.className = 'fd-hint'; h.textContent = hint; r.appendChild(h) }
      const acts = document.createElement('span'); acts.className = 'fd-actions'
      for (const [label, cls, fn] of buttons) {
        const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label
        b.addEventListener('click', fn); acts.appendChild(b)
      }
      r.appendChild(acts)
      return r
    }

    const inc = list('incoming'); inc.innerHTML = ''
    const incoming = this.incoming()
    if (!incoming.length) leer(inc, t('keine offenen Einladungen'))
    for (const f of incoming) inc.appendChild(row(f.from_name || f.from, '', [
      [t('Annehmen'), 'primary', () => this._respond(f.id, 'accepted')],
      [t('Ablehnen'), 'danger', () => this._respond(f.id, 'declined')],
    ]))

    const fr = list('friends'); fr.innerHTML = ''
    const friends = this.friends()
    if (!friends.length) leer(fr, t('noch keine Freunde'))
    for (const f of friends) fr.appendChild(row(f.name, '', [
      [t('Gespräch'), 'primary', () => this._talk(f)],
      [t('Entfernen'), 'danger', () => this._remove(f.id, f.name)],
    ]))

    const out = list('outgoing'); out.innerHTML = ''
    const outgoing = this.outgoing()
    if (!outgoing.length) leer(out, t('keine'))
    for (const f of outgoing) out.appendChild(row(f.to_name || f.to, t('wartet'), [
      [t('Zurückziehen'), 'danger', () => this._remove(f.id, f.to_name || f.to, { quiet: true })],
    ]))

    // In der Nähe: Anwesenheiten anderer Konten — der Weg, jemanden
    // anzufreunden, dem man gerade gegenübersteht, ohne nach dem Handle zu
    // fragen. Eine Anwesenheit trägt ihren Namen (state.name).
    const near = bd.querySelector('[data-role="near"]'); near.innerHTML = ''
    const bekannt = new Set(this._rows.map(f => String(f.from) === me ? String(f.to) : String(f.from)))
    const presences = (this.ajna.getObjects?.() || [])
      .filter(o => String(o?.type || '').toLowerCase() === 'player' && o.owner && String(o.owner) !== me && !bekannt.has(String(o.owner)))
    const seen = new Set()
    const nahe = presences.filter(o => { if (seen.has(String(o.owner))) return false; seen.add(String(o.owner)); return true })
    if (!nahe.length) leer(near, t('niemand in Sicht'))
    for (const o of nahe) near.appendChild(row(o.state?.name || t('Jemand'), '', [
      [t('Einladen'), 'primary', () => this._invite(o.owner, o.state?.name || '')],
    ]))
  }

  // ── Aktionen ───────────────────────────────────────────────────────────

  _status(text, fehler = false) {
    const el = this._backdrop?.querySelector('[data-role="status"]')
    if (!el) return
    el.hidden = !text
    el.textContent = text || ''
    el.classList.toggle('error', !!fehler)
  }

  async _inviteByQuery(q) {
    this._status(t('suche …'))
    try {
      const r = await this.ajna.resolveUser(q)
      await this._invite(r.id, r.name || q)
      const input = this._backdrop?.querySelector('[data-role="q"]')
      if (input) input.value = ''
    } catch (err) {
      const code = err?.response?.code || err?.response?.data?.code
      this._status(code === 'self' ? t('Das bist du selbst.')
        : code === 'unknown_user' || err?.status === 404 ? t('Kein Konto mit diesem Handle oder dieser E-Mail.')
        : (err?.message || String(err)), true)
    }
  }

  async _invite(userId, name) {
    try {
      const r = await this.ajna.inviteFriend(userId)
      if (r?.accepted) this._status(t('{name} hatte dich schon eingeladen — ihr seid jetzt Freunde.').replace('{name}', name || t('Die andere Seite')))
      else this._status(t('Einladung an {name} gesendet.').replace('{name}', name || userId))
      await this._reload()
    } catch (err) {
      this._status(err?.response?.message || err?.message || String(err), true)
    }
  }

  async _respond(id, status) {
    try { await this.ajna.respondFriendship(id, status); await this._reload() }
    catch (err) { this._toast.show(err?.message || String(err), { title: t('Freunde') }) }
  }

  async _remove(id, name, { quiet = false } = {}) {
    if (!quiet && !window.confirm(t('{name} aus der Freundesliste entfernen?').replace('{name}', name))) return
    try { await this.ajna.removeFriendship(id); await this._reload() }
    catch (err) { this._toast.show(err?.message || String(err), { title: t('Freunde') }) }
  }

  _talk(f) {
    const panel = this._logPanel || window.ajnaLogPanel
    if (!panel?.talkTo) { this._toast.show(t('Kein Chatfenster in dieser Ansicht.'), { title: t('Freunde') }); return }
    this.close()
    panel.talkTo({ userId: f.userId, name: f.name, objectId: null }, { open: true })
  }

  destroy() {
    try { this._unsub?.() } catch {}
    this.close()
    this._launcher?.dispose()
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
    .ajna-fab-friends{position:relative}
    .ajna-friends-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;
      background:#e0533b;color:#fff;font:600 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    .ajna-friends-badge[hidden]{display:none}
    .ajna-friends-backdrop{position:fixed;inset:0;z-index:6000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
    .ajna-friends{width:100%;max-width:520px;max-height:88vh;overflow:auto;margin:0 16px;background:rgba(18,18,22,.97);color:#eaeaea;
      border:1px solid #34343e;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.6);font:13px system-ui,sans-serif}
    .ajna-friends header{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #2b2b33}
    .ajna-friends header h3{margin:0;font:600 15px system-ui,sans-serif;flex:1}
    .ajna-friends .fd-close{background:none;border:none;color:#c9c9d0;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
    .ajna-friends section{padding:8px 14px}
    .ajna-friends h4{margin:6px 0;font:600 11px system-ui,sans-serif;color:#aab;text-transform:uppercase;letter-spacing:.05em}
    .ajna-friends .fd-row{display:flex;align-items:center;gap:8px;padding:6px 8px;margin:3px 0;border-radius:8px;background:rgba(255,255,255,.04)}
    .ajna-friends .fd-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ajna-friends .fd-hint{color:#8b8b96;font-size:12px}
    .ajna-friends .fd-actions{display:flex;gap:6px}
    .ajna-friends button{border-radius:8px;border:1px solid #3a3a44;background:none;color:#eaeaea;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
    .ajna-friends button.primary{background:#2c5d8f;border-color:#2c5d8f;color:#fff}
    .ajna-friends button.danger{border-color:#7a3a3a;color:#f2b8b8}
    .ajna-friends .fd-empty{color:#777;font-style:italic;padding:4px 8px;font-size:12px}
    .ajna-friends .fd-add{display:flex;gap:8px}
    .ajna-friends .fd-add input{flex:1;min-width:0;background:#0f1115;color:#eaeaea;border:1px solid #34343e;border-radius:8px;padding:8px 10px;font:inherit}
    .ajna-friends .fd-add button{background:#2c5d8f;border-color:#2c5d8f;color:#fff}
    .ajna-friends .fd-status{margin-top:6px;color:#9fd39f;font-size:12px}
    .ajna-friends .fd-status.error{color:#f2a0a0}
    .ajna-friends .fd-status[hidden]{display:none}
    .ajna-friends .fd-near{margin-top:10px}
    .ajna-friends .fd-near-title{font-size:11px;color:#8b8b96;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}`
    document.head.appendChild(el)
  }
}
