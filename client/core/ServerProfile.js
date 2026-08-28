// ServerProfile — alles zu EINEM Server an einer Stelle.
//
// Warum ein eigenes Fenster: Die Serverliste trug zuletzt Label, Abzeichen,
// URL, Konto, Standort-Freigabe samt Zurücksetzen, Login-Formular und fünf
// Knöpfe — je Zeile. Bei zwei Servern noch lesbar, bei fünf nicht mehr. Was
// selten gebraucht wird (umbenennen, entfernen, Standard setzen) und was
// erklärungsbedürftig ist (Standort-Freigabe, Karma), liegt jetzt hier.
//
// Die Liste behält, was man häufig tut: an- und abmelden, verbinden und
// trennen. Alles andere ist einen Tipp entfernt.
//
// KARMA STEHT HIER, weil es pro Server geführt wird: Jede Instanz hat eigene
// Konten und eigene Aufträge, also auch ein eigenes Urteil darüber, wie
// verlässlich jemand war. Ein serverübergreifender Wert wäre genau die zentrale
// Instanz, die Ajna nicht sein will.
//
// Der Punktestand kommt aus dem angemeldeten Nutzerdatensatz DIESES Servers
// (`users.karma_points`, serverseitig geführt — der Client kann ihn nicht
// setzen). `getKarma` überschreibt das nur, wenn ein Aufrufer es braucht.

import { privacy } from './PrivacyPolicy.js'
import { publikum } from './PresenceService.js'
import { t } from './i18n.js'
import { infoHint } from './InfoHint.js'
import { renderKarma } from './karma.js'

const STYLE_ID = 'ajna-sp-style'

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class ServerProfile {
  /**
   * @param {{
   *   ajna: object,
   *   parent?: HTMLElement,
   *   getKarma?: (serverId: string) => number,
   *   onChanged?: () => void,
   * }} opts
   */
  constructor({ ajna, parent = document.body, getKarma = null, onChanged = null }) {
    this.ajna = ajna
    this.parent = parent
    this.getKarma = getKarma
    this.onChanged = onChanged
    this._id = null
    this._injectStyles()
  }

  /** Server aus der Manager-Liste holen — immer frisch, nie gecacht. */
  _server() {
    try { return (this.ajna.getServers?.() || []).find(s => s.id === this._id) || null }
    catch { return null }
  }

  /**
   * Profil eines Servers öffnen.
   * @param {string} serverId
   */
  open(serverId) {
    this.close()
    this._id = serverId
    if (!this._server()) return
    const ov = document.createElement('div')
    ov.className = 'ajna-sp-overlay'
    ov.innerHTML = `<div class="ajna-sp" role="dialog" aria-modal="true" aria-label="Server-Profil">
      <header>
        <h3 data-role="titel"></h3>
        <button class="sp-close" type="button" aria-label="Schließen">×</button>
      </header>
      <div class="sp-body" data-role="body"></div>
      <div class="sp-status" data-role="status" hidden></div>
    </div>`
    ov.addEventListener('click', e => { if (e.target === ov) this.close() })
    ov.querySelector('.sp-close').addEventListener('click', () => this.close())
    this.parent.appendChild(ov)
    this._ov = ov
    this._body = ov.querySelector('[data-role="body"]')
    this._titel = ov.querySelector('[data-role="titel"]')
    this._statusEl = ov.querySelector('[data-role="status"]')
    this._unsubPriv = privacy.onChange(() => this._render())
    this._render()
  }

  close() {
    try { this._unsubPriv?.() } catch {}
    this._unsubPriv = null
    this._ov?.remove()
    this._ov = this._body = this._titel = this._statusEl = null
    this._id = null
  }

  destroy() { this.close() }

  _status(text, art = '') {
    if (!this._statusEl) return
    this._statusEl.textContent = text || ''
    this._statusEl.hidden = !text
    this._statusEl.className = `sp-status${art ? ' ' + art : ''}`
  }

  // ── Zeichnen ───────────────────────────────────────────────────────────

  _render() {
    const s = this._server()
    if (!s || !this._body) { this.close(); return }
    this._titel.textContent = s.label || s.url

    const konto = s.isLoggedIn
      ? (s.currentUser?.email || s.currentUser?.name || 'angemeldet')
      : 'nicht angemeldet'
    const zustand = !s.isLoggedIn ? 'abgemeldet'
      : (s.isConnected ? 'verbunden' : 'angemeldet, nicht verbunden')

    this._body.innerHTML = `
      <dl class="sp-fakten">
        <dt>Adresse</dt><dd class="sp-url">${esc(s.url)}</dd>
        <dt>Konto</dt><dd>${esc(konto)}</dd>
        <dt>Zustand</dt><dd>${esc(zustand)}${s.isDefault ? ' · Standard' : ''}</dd>
      </dl>

      <div class="sp-abschnitt">Karma auf diesem Server</div>
      ${s.isLoggedIn ? '<div data-role="karma"></div>'
        : '<div class="sp-fussnote">Erst nach Anmeldung — Karma hängt am Konto.</div>'}

      <div class="sp-abschnitt">Standort-Freigabe <span data-role="priv-info"></span></div>
      <div class="sp-priv-zeile">
        <select data-role="priv">
          ${privacy.LEVELS.map(l => `<option value="${l}">${esc(privacy.label(l))}</option>`).join('')}
        </select>
        <button type="button" data-role="priv-reset" title="${esc(t('Wieder dem Standard folgen'))}">↺</button>
      </div>

      <div class="sp-abschnitt">Wer sieht mich hier</div>
      <div class="sp-priv-zeile">
        <select data-role="publikum">
          ${publikum.WERTE.map(w => `<option value="${w}">${esc(publikum.label(w))}</option>`).join('')}
        </select>
      </div>
      <div class="sp-fussnote">Gilt nur bei Standort-Freigabe „Genau".</div>

      <div class="sp-abschnitt">Verwaltung</div>
      <div class="sp-aktionen">
        <button type="button" class="sp-btn" data-a="rename">Umbenennen</button>
        <button type="button" class="sp-btn" data-a="default"${s.isDefault ? ' disabled' : ''}>Als Standard</button>
        <button type="button" class="sp-btn gefahr" data-a="remove"${s.isDefault ? ' disabled' : ''}>Entfernen</button>
      </div>`

    // Punktestand des hier angemeldeten Kontos. Nicht angemeldet → 0, denn
    // Karma hängt am Konto, nicht am Server.
    let punkte = 0
    try {
      punkte = this.getKarma
        ? (Number(this.getKarma(s.id)) || 0)
        : (Number(s.currentUser?.karma_points) || 0)
    } catch { punkte = 0 }
    renderKarma(this._body.querySelector('[data-role="karma"]'), punkte)

    // Standort-Freigabe — dieselbe Mechanik wie vorher in der Serverzeile:
    // eigene Stufe je Server, ↺ nur bei einer Übersteuerung.
    const sel = this._body.querySelector('[data-role="priv"]')
    const reset = this._body.querySelector('[data-role="priv-reset"]')
    sel.value = privacy.levelFor(s.id)
    reset.style.visibility = privacy.hasOverride(s.id) ? 'visible' : 'hidden'
    sel.addEventListener('change', () => { privacy.setLevel(s.id, sel.value); this._render() })

    // Publikum der eigenen Anwesenheit. Die Berechtigung hängt am Datensatz —
    // deshalb wird die Anwesenheit neu angelegt, nicht nachträglich umgehängt.
    const pub = this._body.querySelector('[data-role="publikum"]')
    if (pub) {
      pub.value = publikum.fuer(s.id)
      pub.addEventListener('change', () => {
        publikum.setze(s.id, pub.value)
        try { window.ajnaPresence?.erneuere(s.id) } catch {}
      })
    }
    reset.addEventListener('click', () => { privacy.clearLevel(s.id); this._render() })
    this._body.querySelector('[data-role="priv-info"]').appendChild(infoHint(() => {
      const lvl = privacy.levelFor(s.id)
      const kopf = privacy.hasOverride(s.id)
        ? t('Eigene Einstellung für diesen Server.') + '\n\n'
        : t('Folgt dem Standard aus den Einstellungen.') + '\n\n'
      return kopf + (privacy.LEVEL_INFO[lvl]?.hint || '')
    }, { title: () => `Standort-Freigabe: ${privacy.label(privacy.levelFor(s.id))}` }))

    this._body.querySelectorAll('.sp-btn').forEach(b =>
      b.addEventListener('click', () => this._aktion(b.dataset.a)))
  }

  async _aktion(key) {
    const s = this._server()
    if (!s) return
    try {
      if (key === 'rename') {
        const next = prompt(t('Neuer Name für diesen Server:'), s.label)
        if (!next || !next.trim()) return
        this.ajna.renameServer(s.id, next.trim())
        this._status(`Umbenannt: ${next.trim()}`)
      } else if (key === 'default') {
        this.ajna.setDefaultServer(s.id)
        this._status(`Standard: ${s.label}`)
      } else if (key === 'remove') {
        if (!confirm(`Server „${s.label}" wirklich entfernen? Das Login-Token wird gelöscht.`)) return
        await this.ajna.removeServer(s.id)
        this.onChanged?.()
        this.close()
        return
      }
      this.onChanged?.()
      this._render()
    } catch (err) {
      this._status(err?.message || String(err), 'fehler')
    }
  }

  // ── CSS ────────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
    .ajna-sp-overlay{position:fixed;inset:0;z-index:6300;background:rgba(0,0,0,.5);
      display:flex;align-items:center;justify-content:center;padding:16px}
    .ajna-sp{width:100%;max-width:440px;max-height:min(86vh,700px);display:flex;flex-direction:column;
      background:rgba(18,18,22,.98);color:#eaeaea;border:1px solid #34343e;border-radius:14px;
      box-shadow:0 12px 48px rgba(0,0,0,.55)}
    .ajna-sp header{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid #2b2b33}
    .ajna-sp header h3{margin:0;font:600 15px system-ui,sans-serif;flex:1 1 auto;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ajna-sp header button{background:none;border:none;color:#b8b8c0;font-size:20px;cursor:pointer;padding:0 6px}
    .ajna-sp header button:hover{color:#fff}
    .ajna-sp .sp-body{overflow-y:auto;padding:12px 13px 14px}

    .ajna-sp .sp-fakten{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:0;
      font:12px system-ui,sans-serif}
    .ajna-sp .sp-fakten dt{color:#8b8b96}
    .ajna-sp .sp-fakten dd{margin:0;color:#e2e2e8}
    .ajna-sp .sp-url{font:11px ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
    .ajna-sp .sp-abschnitt{display:flex;align-items:center;gap:6px;margin:16px 0 8px;
      font:600 11px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#f1c40f}
    .ajna-sp .sp-fussnote{margin-top:7px;font:11px/1.5 system-ui,sans-serif;color:#7f8796}
    .ajna-sp .sp-priv-zeile{display:flex;gap:8px;align-items:center}
    .ajna-sp .sp-priv-zeile select{flex:1 1 auto;background:#0f1115;color:#eaeaea;border:1px solid #33343e;
      border-radius:8px;padding:7px 9px;font:13px system-ui,sans-serif}
    .ajna-sp .sp-priv-zeile button{background:none;border:none;color:#9b9ba6;font-size:15px;cursor:pointer}
    .ajna-sp .sp-priv-zeile button:hover{color:#fff}
    .ajna-sp .sp-aktionen{display:flex;flex-wrap:wrap;gap:8px}
    .ajna-sp .sp-btn{flex:1 1 auto;min-height:38px;border-radius:9px;border:1px solid #3a3a44;
      background:#26262e;color:#e2e2e8;font:600 12px system-ui,sans-serif;cursor:pointer;padding:0 12px}
    .ajna-sp .sp-btn:hover{background:#30303a}
    .ajna-sp .sp-btn.gefahr{background:#7a3030;border-color:#8f3a3a;color:#fff}
    .ajna-sp .sp-btn.gefahr:hover{background:#8f3a3a}
    .ajna-sp .sp-btn:disabled{opacity:.4;cursor:not-allowed}
    .ajna-sp .sp-status{padding:9px 13px;border-top:1px solid #2b2b33;
      font:12px system-ui,sans-serif;color:#9b9ba6}
    .ajna-sp .sp-status.fehler{color:#f0a893}
    .ajna-sp .sp-status[hidden]{display:none}`
    document.head.appendChild(el)
  }
}
