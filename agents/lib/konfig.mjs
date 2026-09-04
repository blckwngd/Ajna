// konfig — Einstellungen zur Laufzeit, ohne Neustart.
//
// WOFÜR: Agents laufen als eigene Prozesse. Eine geänderte Env-Variable heißt
// sonst: Prozess neu starten, und zwar jeden einzelnen. Mit einem Datensatz und
// einem Realtime-Abo wirkt eine Änderung sofort.
//
// DIE REGEL: `.env` liefert die VORGABE, die Datenbank ÜBERSTEUERT sie.
//
// Eine frische Installation läuft damit aus der `.env` allein — es muss nichts
// angelegt werden, bevor irgendetwas startet. Im Betrieb dreht man an der
// Datenbank. Umgekehrt wäre es schlechter: Dann bräuchte jede Neuinstallation
// erst Datensätze.
//
// ZWEI BEREICHE, UND DAS IST KEINE DOPPELUNG
//
//   Konfig.eigene(ajna, …)   → `agent_settings`, dem Agenten-Konto gehörend
//   Konfig.instanz(ajna, …)  → `settings`, dem Server gehörend
//
// Ein Agent ist kein Teil der Instanz, an der er hängt. Er meldet sich dort an
// wie ein Spieler, kann an mehreren Servern hängen, und an einem Server können
// mehrere Agents desselben Typs arbeiten. Seine Regler sind seine eigene Sache:
// zwei World-Directors dürfen verschiedene Soll-Bestände haben, und kein
// Spieler soll mitlesen können, wie die Welt eingestellt ist.
//
// `instanz` ist für das, was wirklich dem Server gehört — Aufbewahrungsfristen,
// Aufräum-Schonzeiten. Im Zweifel ist `eigene` richtig.
//
// WAS NIRGENDWO HINEINGEHÖRT: Geheimnisse (Datensätze landen in jeder
// Sicherung, eine Regel kann man falsch setzen), alles was VOR PocketBase
// gebraucht wird (Henne und Ei), und gerätelokale Entscheidungen der Nutzer.
//
// BENUTZUNG
//
//   const { ajna } = await bootAgent('director')
//   const konf = await Konfig.eigene(ajna, { praefix: 'wd' })
//   await konf.saee([
//     { name: 'count.enemy', envName: 'WD_COUNT_ENEMY', vorgabe: 3,
//       note: 'Soll-Bestand Gegner je Zentrum' },
//   ])
//   konf.ganz('count.enemy', 'WD_COUNT_ENEMY', 3)   // DB → Env → Vorgabe
//   konf.beiAenderung(() => neuBerechnen())
//
// Gelesen wird IMMER aus dem Speicher — `zahl()` ist synchron und billig genug
// für eine Schleife. Nachgeladen wird über das Abo.

/** Schlüssel, die NIE aus der Datenbank kommen dürfen. */
const VERBOTEN = /(pass|secret|token|key|credential|_pw$)/i

/** Leer heißt „nicht gesetzt" — nicht „der Wert ist null". */
const leer = (v) => v === null || v === undefined || v === ''

export class Konfig {
  /**
   * @param {object} ajna  AjnaManager (bereits angemeldet)
   * @param {object} [opts]
   * @param {string} [opts.praefix]  allen Schlüsseln vorangestellt, damit
   *        `count.enemy` des World-Directors nicht mit dem eines anderen
   *        Agenten kollidiert, falls beide dasselbe Konto benutzen.
   * @param {boolean} [opts.eigen]  true = `agent_settings` (dem Konto gehörend),
   *        false = `settings` (der Instanz gehörend).
   */
  constructor(ajna, { praefix = '', eigen = true, log = null } = {}) {
    this.ajna = ajna
    this.eigen = eigen !== false
    this.collection = this.eigen ? 'agent_settings' : 'settings'
    this.praefix = praefix ? String(praefix).replace(/\.$/, '') + '.' : ''
    this.log = log || ((m) => console.log(`[konfig] ${m}`))
    this._werte = new Map()
    this._hoerer = new Set()
    this._unsub = null
    // Kennt dieser Server die Collection ueberhaupt? Ein Agent haengt sich an
    // fremde Server, und aeltere kennen sie nicht.
    this._da = false
  }

  /** Die Einstellungen DIESES AGENTEN. Der Normalfall. */
  static async eigene(ajna, opts = {}) {
    return Konfig._starte(ajna, { ...opts, eigen: true })
  }

  /** Die Einstellungen DER INSTANZ. Nur für das, was wirklich dem Server gehört. */
  static async instanz(ajna, opts = {}) {
    return Konfig._starte(ajna, { ...opts, eigen: false })
  }

  static async _starte(ajna, opts) {
    const k = new Konfig(ajna, opts)
    await k.lade()
    await k.abonniere()
    return k
  }

  /** Das eigene Konto — Eigentümer der Datensätze im `eigen`-Bereich. */
  meinKonto() {
    const s = this.ajna?.pb?.authStore
    return s?.record?.id || s?.model?.id || null
  }

  async lade() {
    try {
      // Die Regeln der Collection filtern bereits auf den Besitzer. Der Filter
      // hier ist trotzdem da: Er macht die Absicht im Code sichtbar und schützt
      // vor einer Instanz, deren Regeln jemand aufgeweicht hat.
      const opt = { sort: 'key' }
      if (this.eigen) {
        const ich = this.meinKonto()
        if (!ich) { this.log('nicht angemeldet — es gilt die .env'); return }
        opt.filter = `owner = "${ich}"`
      }
      const liste = await this.ajna.pb.collection(this.collection).getFullList(opt)
      this._da = true
      this._werte.clear()
      for (const r of liste) this._werte.set(r.key, r.value)
      const gesetzt = liste.filter(r => !leer(r.value)).length
      if (liste.length) this.log(`${liste.length} Regler, davon ${gesetzt} gesetzt (leer = es gilt die .env)`)
    } catch (err) {
      // Ein Agent, der ohne Datenbank-Einstellungen nicht startet, wäre ein
      // Rückschritt gegenüber der .env. Fehlt die Collection oder das Recht,
      // gilt eben die Env.
      this.log(`nicht lesbar (${err?.message || err}) — es gilt die .env`)
    }
  }

  async abonniere() {
    if (this._unsub) return
    const ich = this.eigen ? this.meinKonto() : null
    try {
      this._unsub = await this.ajna.pb.collection(this.collection).subscribe('*', (e) => {
        const r = e?.record
        if (!r?.key) return
        // Im eigenen Bereich liefert der Server ohnehin nur eigene Datensätze;
        // die Prüfung kostet nichts und schließt den Fall aus, dass eine
        // gelockerte Regel fremde Werte hereinreicht.
        if (ich && r.owner && r.owner !== ich) return
        if (e.action === 'delete') this._werte.delete(r.key)
        else this._werte.set(r.key, r.value)
        this.log(`"${r.key}" geändert → ${leer(r.value) ? '(leer → .env)' : JSON.stringify(r.value)}`)
        for (const h of this._hoerer) { try { h(r.key) } catch {} }
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
   * Die Regler in der Verwaltungsoberfläche sichtbar machen — als LEERE
   * Datensätze mit Erklärung.
   *
   * WARUM LEER UND NICHT MIT DEM AKTUELLEN WERT: Stünde der Env-Wert darin,
   * würde er die `.env` ab sofort übersteuern. Eine spätere Änderung an der
   * `.env` bliebe dann wirkungslos, ohne dass jemand sähe warum. Ein leerer
   * Datensatz ist ein FORMULARFELD, kein Wert: Er zeigt, woran man drehen kann,
   * und ändert nichts, solange niemand dreht. Die Vorgabe steht in der Notiz.
   *
   * Vorhandene Datensätze werden NIE angefasst — sonst überschriebe jeder
   * Neustart, was ein Mensch eingetragen hat.
   *
   * Nur im `eigen`-Bereich: In die Instanz-Einstellungen darf ein Agent nicht
   * schreiben, und er soll es auch nicht.
   *
   * @param {Array<{name: string, envName?: string, vorgabe?: any, note?: string}>} regler
   */
  async saee(regler = []) {
    if (!this.eigen) { this.log('saee() nur im eigenen Bereich — übersprungen'); return 0 }
    // Ohne lesbare Collection wuerde jeder einzelne Regler in einen eigenen
    // fehlschlagenden Schreibversuch laufen — bei jedem Start, gegen einen
    // Server, der davon gar nichts weiss. Einmal sagen und es lassen.
    if (!this._da) { this.log(`${this.collection} hier nicht vorhanden — keine Regler angelegt`); return 0 }
    const ich = this.meinKonto()
    if (!ich) return 0
    let neu = 0
    for (const r of regler) {
      const voll = this.praefix + r.name
      if (this._werte.has(voll)) continue
      // Ein Geheimnis darf nicht einmal als Formularfeld erscheinen — sonst
      // trägt es früher oder später jemand ein. Wie in `roh()` zählt beides:
      // der Env-Name und der Schlüssel selbst.
      if ((r.envName && VERBOTEN.test(r.envName)) || VERBOTEN.test(voll)) continue
      const teile = []
      if (r.note) teile.push(r.note)
      if (r.vorgabe !== undefined) teile.push(`Vorgabe: ${r.vorgabe}`)
      if (r.envName) teile.push(r.envName)
      try {
        await this.ajna.pb.collection(this.collection).create({
          owner: ich,
          key: voll,
          value: null,
          note: teile.join(' · ').slice(0, 500),
        })
        neu++
      } catch (err) {
        // Häufigster Fall: Ein zweiter Prozess war schneller (Unique-Index).
        // Kein Grund, den Start abzubrechen.
      }
      // So oder so gilt der Regler ab jetzt als bekannt — ein zweiter Anlauf
      // im selben Lauf würde nur denselben Fehler noch einmal erzeugen.
      this._werte.set(voll, null)
    }
    if (neu) this.log(`${neu} Regler angelegt — leer, es gilt weiter die .env`)
    return neu
  }

  /**
   * Rohwert: Datenbank, sonst Env, sonst Vorgabe.
   * @param {string} name      Schlüssel OHNE Präfix
   * @param {string?} envName  Env-Variable, die dasselbe steuert
   */
  roh(name, envName = null, vorgabe = undefined) {
    const voll = this.praefix + name
    // GEHEIMNISSE ZUERST, VOR DER DATENBANK.
    //
    // Diese Prüfung stand ursprünglich weiter unten, hinter dem Blick in die
    // Datenbank — und war damit wirkungslos: Ein vorhandener Datensatz wurde
    // zurückgegeben, bevor überhaupt jemand fragte, ob der Name ein Geheimnis
    // bezeichnet. Die Zusage „kommt immer aus der Env" stimmte nur, solange
    // niemand den Datensatz anlegte. Genau dann hätte sie zählen müssen.
    //
    // Geprüft wird der Env-Name UND der Schlüssel: In der Verwaltung tippt
    // jemand den Schlüssel, nicht den Env-Namen. Ein Fehlalarm heißt hier nur
    // „bleibt bei der .env" — die harmlose Richtung.
    if ((envName && VERBOTEN.test(envName)) || VERBOTEN.test(voll)) {
      return (envName ? process.env[envName] : undefined) ?? vorgabe
    }
    if (this._werte.has(voll)) {
      const v = this._werte.get(voll)
      if (!leer(v)) return v
    }
    if (envName) {
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
    if (leer(v)) return vorgabe
    return /^(1|true|yes|on|ja)$/i.test(String(v))
  }

  /** Ganze Struktur (JSON-Wert), z. B. eine Liste. */
  objekt(name, vorgabe = null) {
    const v = this._werte.get(this.praefix + name)
    return leer(v) ? vorgabe : v
  }

  /** Was gerade aus der Datenbank kommt — für Diagnose-Ausgaben. */
  ausDatenbank() {
    return Object.fromEntries(this._werte)
  }
}
