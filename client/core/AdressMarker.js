// AdressMarker — flüchtige Marker für die Treffer der Adress-Lupe.
//
// WAS DAS IST: Je gefundener Adresse ein sichtbarer Eintrag an ihrer echten
// Position — im 3D-Raum als Pfeiler mit Beschriftung, auf der Karte als Punkt
// mit Popup. Mehrere Abfragen sammeln sich an, damit man sich ein Bild von
// einem ganzen Areal machen kann.
//
// WARUM NICHT ALS WELTOBJEKT: Weil die Angaben flüchtig sind und niemandem
// sonst gehören. Ein Objekt in `objects` wäre dauerhaft, für alle sichtbar und
// in der Datenbank — genau das, was `docs/fluechtige-daten.md` ausschliesst.
// Diese Marker sind reine Babylon-Knoten bzw. Leaflet-Layer: im Arbeitsspeicher,
// nach einem Neuladen fort, nirgends gespeichert. Die Flüchtigkeit ist hier
// nicht zugesichert, sondern bauartbedingt.
//
// VORBILDER im Projekt: UwbAnchorOverlay (3D, eigener TransformNode) und
// InterestAreaDebug (Karte, eigene LayerGroup). Diese Klasse bedient beides,
// weil Datenhaltung und Lebensdauer für beide dieselben sind — nur gezeichnet
// wird verschieden.
//
// ABONNIERT SELBST: Der Client besteht aus mehreren Webpack-Bündeln mit je
// eigenen Modulinstanzen. Sich an das Gesprächsfenster zu hängen hiesse, auf
// ein fremdes Bündel zu hoffen. Stattdessen hört diese Klasse direkt auf
// `onChat` des Managers, den sie bekommt.

const MAX_MARKER = 200          // Obergrenze: sammeln ja, unbegrenzt nein
const RASTER = 1e5              // ~1 m Raster für die Doppelten-Erkennung

const PFEILER_H = 1.6           // Höhe des Pfeilers in Metern
const TAFEL_B = 2.0             // Tafelbreite zusammengeklappt, in Metern
const TAFEL_B_GROSS = 3.4       // aufgeklappt — lesbar aus ein paar Schritten
const RAND = 36                 // Innenabstand der grossen Tafel, in Pixeln
const MAX_ZEILEN = 26           // darüber wird die Tafel zur Wand

// Schriftbild der aufgeklappten Tafel. `zeile` ist der Zeilenvorschub — er
// bestimmt zugleich die Höhe der Tafel, die sich aus dem Inhalt ergibt.
//
// WIE GROSS DIE SCHRIFT WIRKLICH IST, entscheidet nicht die Pixelzahl, sondern
// das Verhältnis Pixel zu Tafelbreite: `px / 1024 * TAFEL_B_GROSS` ergibt die
// Höhe in Metern. Genau hier lag der Fehler der ersten Fassung — 30 px auf
// einer 2,8-m-Tafel sind 8 cm, die kleine Tafel hatte mit 34 px auf 1,6 m
// bereits 11 cm. Die aufgeklappte Tafel war also KLEINER geschrieben als die
// zusammengeklappte. Jetzt: Titel 20 cm, Angaben 14 cm, Herkunft 11 cm.
const SCHRIFT = {
  titel:    { font: 'bold 60px sans-serif',   zeile: 76, farbe: null },   // null = Farbe der Genauigkeit
  kopf:     { font: '44px sans-serif',        zeile: 58, farbe: '#ffffff' },
  notiz:    { font: 'italic 38px sans-serif', zeile: 52, farbe: '#b9c0c7' },
  feld:     { font: '42px sans-serif',        zeile: 56, farbe: '#ffffff' },
  herkunft: { font: '32px sans-serif',        zeile: 42, farbe: '#9aa0a6' },
  fuss:     { font: '32px sans-serif',        zeile: 46, farbe: '#9aa0a6' },
}

/** Zwei Treffer an derselben Stelle sind derselbe Eintrag. */
const schluesselVon = (a) =>
  `${Math.round(a.lat * RASTER)}:${Math.round(a.lon * RASTER)}`

export class AdressMarker {
  /**
   * @param {{
   *   ajna: object,           AjnaManager (für onChat / Objektänderungen)
   *   scene?: object, geo?: object,     3D-Ansicht (beides oder keines)
   *   L?: object, map?: object,         Karten-Ansicht (beides oder keines)
   * }} opts
   */
  constructor({ ajna, scene = null, geo = null, L = null, map = null } = {}) {
    this.ajna = ajna
    this.scene = scene
    this.geo = geo
    this.L = L
    this.map = map

    /** @type {Map<string, {daten: object, node?: object, layer?: object}>} */
    this._marker = new Map()
    /** Werkzeuge, deren Treffer gerade angezeigt werden. */
    this._werkzeuge = new Set()
    this._offs = []

    if (scene) {
      this._root = new BABYLON.TransformNode('adressMarker', scene)
    }
    if (L && map) {
      this._layer = L.layerGroup().addTo(map)
    }
  }

  /** Anhängen und auf das Ende der Anzeige horchen. */
  async start() {
    // EINTRAGEN, NICHT UEBERSCHREIBEN: In der Shell laufen beide Ansichten —
    // die Karte aus `map.js`, der 3D-Raum aus `main.js`. Beide legten bisher
    // ihre Instanz unter DEMSELBEN `window.ajnaAdressMarker` ab, die zweite
    // verdeckte die erste, und der Wartering erschien nur in einer der beiden
    // Ansichten. Die Liste haelt alle.
    try {
      if (typeof window !== 'undefined') {
        if (!Array.isArray(window.ajnaAdressMarkers)) window.ajnaAdressMarkers = []
        window.ajnaAdressMarkers.push(this)
      }
    } catch {}
    try {
      this._offs.push(await this.ajna.onChat((m) => this._aufNachricht(m)))
    } catch (err) {
      console.warn('[adress-marker] Chat-Abo:', err?.message || err)
    }
    // ANTIPPEN KLAPPT DIE TAFEL AUF. Es braucht einen eigenen Beobachter: Die
    // Marker sind keine Weltobjekte, also kennt sie weder das Aktionsmenue noch
    // der Tipp-Weg von `main.js`. Ein Tipp DANEBEN klappt alles wieder zu —
    // das ist das „Unfocus".
    if (this.scene) {
      try {
        this._zeigerObs = this.scene.onPointerObservable.add((ev) => {
          if (ev?.type !== BABYLON.PointerEventTypes?.POINTERTAP) return
          // Der Treffer aus dem Ereignis ist der GENAUESTE: Er stammt aus
          // demselben Strahl, den der Spieler gesehen hat — im immersiven XR
          // aus dem Controller, wo `pointerX/Y` gar nichts aussagen. Und weil
          // er das NAECHSTE Mesh liefert, oeffnet eine Tafel hinter einer Wand
          // sich nicht aus Versehen.
          let key = null
          if (ev.pickInfo) {
            key = ev.pickInfo.pickedMesh?.metadata?.adressTafel || null
          } else {
            const treffer = this.scene.pick(this.scene.pointerX, this.scene.pointerY,
              (m) => !!m?.metadata?.adressTafel)
            key = treffer?.hit ? treffer.pickedMesh?.metadata?.adressTafel : null
          }
          if (key) this._umschalten(key)
          else this._alleZuklappen()
        })
      } catch (err) {
        console.warn('[adress-marker] Zeiger-Abo:', err?.message || err)
      }
    }

    // Die Marker stehen, bis die Lupe ins Inventar wandert. Das ist der
    // Moment, in dem das Werkzeug `carried_by` bekommt.
    try {
      this._offs.push(this.ajna.onObjectEvent?.((rec) => {
        if (!rec?.id || !this._werkzeuge.has(rec.id)) return
        if (rec.carried_by) this.leeren()
      }) || (() => {}))
    } catch (err) {
      console.warn('[adress-marker] Objekt-Abo:', err?.message || err)
    }
    return this
  }

  _aufNachricht(m) {
    // NUR flüchtige Nachrichten mit Adressdaten. Ohne diese Prüfung würde jede
    // beliebige Chat-Nachricht mit einem `adressen`-Feld Marker setzen.
    if (m?.ephemeral !== true) return
    const liste = m?.meta?.adressen
    if (!Array.isArray(liste) || !liste.length) return
    if (m?.meta?.werkzeug) {
      const roh = String(m.meta.werkzeug).split(':').pop()
      this._werkzeuge.add(roh)
      this._wartenAus(roh)   // Antwort da — Ring weg
    }
    this.hinzufuegen(liste)
    // `geprueft` enthält AUCH die vom Filter entfernten Adressen. Nur die
    // angezeigten zu protokollieren hiesse, die Frage „was wurde eigentlich
    // nachgeschlagen?" unbeantwortet zu lassen.
    this._insProtokoll(m.meta.geprueft || liste)
  }

  /**
   * Die nachgeschlagenen Adressen ins Protokoll schreiben — Kategorie `debug`,
   * also sichtbar unter „Alle", nicht im Gespräch. So lässt sich nachvollziehen,
   * WAS abgefragt wurde, ohne die Unterhaltung mit Fundstellen zuzustellen.
   *
   * ZWEI DINGE, DIE HIER ZÄHLEN:
   *
   *   • `ephemeral: true` — sonst landet die Auskunft über `MessageLog._save()`
   *     in `localStorage`, und die ganze Zusage der Flüchtigkeit wäre an dieser
   *     Zeile gebrochen. Die Einträge stehen im Fenster und sind nach einem
   *     Neuladen fort.
   *   • `window.ajnaLog` statt des importierten Verlaufs — der Client besteht
   *     aus mehreren Bündeln mit je eigener Modulinstanz. Wer den Import nimmt,
   *     schreibt in den Verlauf SEINES Bündels, und im Fenster erscheint nichts.
   */
  _insProtokoll(liste) {
    const log = (typeof window !== 'undefined' && window.ajnaLog) || null
    if (!log?.push) return
    for (const a of liste) {
      const wie = a.genauigkeit && a.genauigkeit !== 'genau' ? ' (Lage geschätzt)' : ''
      // `felder` ist je nach Quelle eine Liste (Marker) oder schon eine Zahl
      // (die kompakte Protokoll-Fassung aus `meta.geprueft`).
      const felder = Array.isArray(a.felder) ? a.felder.length : (a.felder || 0)
      const weg = Number.isFinite(a.entfernungM) ? ` (${a.entfernungM} m)` : ''
      log.push(
        `Adress-Lupe: ${a.titel || 'Adresse'}${a.ort ? `, ${a.ort}` : ''}${weg}${wie}` +
        ` — ${felder} Angabe(n)`,
        'debug', { ephemeral: true })
    }
  }

  /**
   * Treffer dazulegen. Mehrfach dieselbe Stelle ergibt EINEN Marker — sonst
   * stapeln sich bei wiederholter Abfrage identische Beschriftungen übereinander.
   */
  hinzufuegen(adressen) {
    for (const a of adressen) {
      if (!Number.isFinite(a?.lat) || !Number.isFinite(a?.lon)) continue
      const key = schluesselVon(a)
      if (this._marker.has(key)) { this._aktualisieren(key, a); continue }
      if (this._marker.size >= MAX_MARKER) {
        // Ältesten weglassen statt unbegrenzt wachsen.
        const [alt] = this._marker.keys()
        this._entfernen(alt)
      }
      const eintrag = { daten: a, gross: false }
      if (this._root) {
        const teile = this._zeichne3d(key, a, false)
        eintrag.node = teile?.node || null
        eintrag.tafel = teile?.tafel || null
      }
      if (this._layer) eintrag.layer = this._zeichneKarte(key, a)
      this._marker.set(key, eintrag)
    }
  }

  /** Neue Felder an einer bekannten Stelle: neu zeichnen statt verdoppeln. */
  _aktualisieren(key, a) {
    const alt = this._marker.get(key)
    if (!alt) return
    if (JSON.stringify(alt.daten.felder) === JSON.stringify(a.felder)) return
    // War die Tafel offen, bleibt sie es: Wer gerade liest, soll nicht dadurch
    // zugeklappt werden, dass eine Nachlieferung eintrifft.
    const warOffen = !!alt.gross
    this._entfernen(key)
    const eintrag = { daten: a, gross: warOffen }
    if (this._root) {
      const teile = this._zeichne3d(key, a, warOffen)
      eintrag.node = teile?.node || null
      eintrag.tafel = teile?.tafel || null
    }
    if (this._layer) eintrag.layer = this._zeichneKarte(key, a)
    this._marker.set(key, eintrag)
  }

  _entfernen(key) {
    const e = this._marker.get(key)
    if (!e) return
    try { e.node?.dispose(false, true) } catch {}
    try { if (e.layer) this._layer?.removeLayer(e.layer) } catch {}
    this._marker.delete(key)
  }

  // ── „Grübeln": sichtbar warten ──────────────────────────────────────────
  //
  // Zwischen Anstupsen und Antwort vergehen Sekunden — Overpass, Impressum,
  // Register, Telefonbuch nacheinander. Ohne Zeichen wirkt das wie ein toter
  // Knopf, und man stupst erneut.
  //
  // Gezeichnet wird ein eigener, pulsierender Ring AM Werkzeug, nicht das
  // Werkzeug selbst: Dessen Darstellung gehört der Szene bzw. der Karte, und
  // ein Overlay, das fremde Meshes verändert, hinterlässt Spuren, sobald etwas
  // schiefgeht. Ein eigener Knoten lässt sich immer sauber wegräumen.

  /**
   * @param {string} objektId  composite oder roh
   * @param {boolean} an
   */
  wartet(objektId, an = true) {
    const roh = String(objektId || '').split(':').pop()
    if (!an) { this._wartenAus(roh); return }
    if (this._warten?.has(roh)) return

    const obj = this.ajna?.getObjectById?.(objektId) || this.ajna?.getObjectById?.(roh)
    if (!Number.isFinite(obj?.lat) || !Number.isFinite(obj?.lon)) return

    this._warten = this._warten || new Map()
    const eintrag = { seit: Date.now() }

    // DAS WERKZEUG SELBST HUEPFT. Der Ring sagt „hier passiert etwas", das
    // Huepfen sagt „DIESES Ding arbeitet" — und es ist von weitem zu sehen,
    // auch wenn der Ring am Boden gerade von einem Haus verdeckt ist.
    // Die Bewegung gehoert der Szene, nicht diesem Overlay: `gruebelt()` sitzt
    // im GameObject und arbeitet auf dem Gesten-Knoten, damit die Geo-Position
    // unangetastet bleibt.
    const go = this._gameObjektVon(objektId, roh)
    if (go?.gruebelt) { try { go.gruebelt(true); eintrag.go = go } catch {} }

    if (this._root && this.scene) {
      const p = this.geo?.toLocalRef?.(obj.lat, obj.lon, 0, 'ground')
      if (p) {
        const ring = BABYLON.MeshBuilder.CreateTorus(`adrWarten_${roh}`,
          { diameter: 0.9, thickness: 0.06, tessellation: 24 }, this.scene)
        ring.position = new BABYLON.Vector3(p.x, p.y + 0.05, p.z)
        ring.isPickable = false
        ring.parent = this._root
        const mat = new BABYLON.StandardMaterial(`adrWartenMat_${roh}`, this.scene)
        mat.emissiveColor = BABYLON.Color3.FromHexString('#ffd479')
        mat.disableLighting = true
        ring.material = mat
        const beobachter = this.scene.onBeforeRenderObservable.add(() => {
          const t = (Date.now() - eintrag.seit) / 1000
          const s = 1 + 0.18 * Math.sin(t * 4)
          ring.scaling.set(s, 1, s)
          ring.rotation.y = t * 1.6
        })
        eintrag.ring = ring
        eintrag.beobachter = beobachter
      }
    }

    if (this._layer && this.L) {
      const kreis = this.L.circleMarker([obj.lat, obj.lon], {
        radius: 10, color: '#ffd479', weight: 2, fill: false, dashArray: '4,4',
      })
      this._layer.addLayer(kreis)
      eintrag.kreis = kreis
      eintrag.takt = setInterval(() => {
        const t = (Date.now() - eintrag.seit) / 1000
        try { kreis.setRadius(9 + 4 * Math.abs(Math.sin(t * 2))) } catch {}
      }, 80)
    }

    // NOTBREMSE: Bleibt die Antwort aus (Agent nicht da, Nachricht verloren),
    // soll der Ring nicht ewig weiterdrehen und Arbeit vortäuschen.
    eintrag.frist = setTimeout(() => this._wartenAus(roh), 90_000)
    this._warten.set(roh, eintrag)
  }

  /**
   * Das GameObject zu einer Objekt-ID finden.
   *
   * Ueber die Meshes der Szene statt ueber eine Objektliste: `objectMap` liegt
   * in `main.js` und steht nur mit eingeschaltetem Welt-Debug auf `window`.
   * Der Rueckverweis am Mesh (`meshOwner.js`) ist dagegen immer da.
   */
  _gameObjektVon(...ids) {
    const gesucht = new Set(ids.filter(Boolean).map(String))
    for (const m of this.scene?.meshes || []) {
      const go = m?.metadata?.gameObject
      if (go && gesucht.has(String(go.id))) return go
    }
    return null
  }

  _wartenAus(roh) {
    const e = this._warten?.get(roh)
    if (!e) return
    try { e.go?.gruebelt?.(false) } catch {}
    try { e.beobachter && this.scene?.onBeforeRenderObservable.remove(e.beobachter) } catch {}
    try { e.ring?.dispose(false, true) } catch {}
    try { if (e.kreis) this._layer?.removeLayer(e.kreis) } catch {}
    try { clearInterval(e.takt) } catch {}
    try { clearTimeout(e.frist) } catch {}
    this._warten.delete(roh)
  }

  /** Alles weg — beim Aufnehmen der Lupe, oder von Hand. */
  leeren() {
    for (const key of [...this._marker.keys()]) this._entfernen(key)
    for (const roh of [...(this._warten?.keys() || [])]) this._wartenAus(roh)
    this._werkzeuge.clear()
  }

  get anzahl() { return this._marker.size }

  /**
   * Hoehen nachziehen, nachdem das Relief geladen oder weitergezogen ist.
   *
   * WARUM NOETIG: `toLocalRef` fragt die Hoehenkacheln, und die sind
   * asynchron. Wer einen Marker setzt, bevor die Kachel da ist, bekommt 0
   * zurueck — also die ebene Startflaeche, und die liegt am Hang unter dem
   * Boden. Neu zeichnen waere Verschwendung: nur X/Z bleiben, Y ist alles,
   * was sich aendert.
   */
  neuAusrichten() {
    if (!this._root || !this.geo?.origin) return
    for (const e of this._marker.values()) {
      const a = e.daten
      if (!e.node || !Number.isFinite(a?.lat)) continue
      const p = this.geo.toLocalRef?.(a.lat, a.lon, 0, 'ground')
      if (p) e.node.position.y = p.y
    }
    for (const e of this._warten?.values() || []) {
      if (!e.ring) continue
      const roh = e.ring.name.replace(/^adrWarten_/, '')
      const obj = this.ajna?.getObjectById?.(roh)
      if (!Number.isFinite(obj?.lat)) continue
      const p = this.geo.toLocalRef?.(obj.lat, obj.lon, 0, 'ground')
      if (p) e.ring.position.y = p.y + 0.05
    }
  }

  // ── 3D ──────────────────────────────────────────────────────────────────
  //
  // ZWEI STUFEN STATT EINER TAFEL. Im Raum ist Platz für wenig: ein Schild mit
  // allen Angaben wäre entweder unleserlich klein oder verdeckte die halbe
  // Umgebung — und das mal zehn Marker. Zusammengeklappt steht deshalb nur,
  // WAS hier ist und WIE VIEL es zu sehen gibt; angetippt zeigt dieselbe Tafel
  // alles, mit Herkunft je Angabe wie im Karten-Popup.
  //
  // IMMER NUR EINE OFFEN: Zwei aufgeklappte Schilder nebeneinander verdecken
  // sich gegenseitig, und der Blick auf die Umgebung ist dahin. Ein Tipp
  // daneben klappt alles wieder zu.

  _zeichne3d(key, a, gross = false) {
    const p = this.geo?.toLocalRef?.(a.lat, a.lon, 0, 'ground')
    if (!p) return null

    const genau = a.genauigkeit === 'genau'
    const farbe = BABYLON.Color3.FromHexString(genau ? '#ffd479' : '#9aa0a6')

    const node = new BABYLON.TransformNode(`adr_${key}`, this.scene)
    node.parent = this._root
    // p.y IST die Gelaendehoehe an dieser Stelle (toLocalRef '.. ground').
    // Sie wegzuwerfen und 0 zu setzen heisst: alles steht auf der ebenen
    // Startflaeche — und die liegt ueberall dort UNTER dem Boden, wo das
    // Gelaende hoeher ist als der Ursprung. Genau so waren die Pfeiler halb
    // im Hang versunken.
    node.position = new BABYLON.Vector3(p.x, p.y, p.z)

    const mat = new BABYLON.StandardMaterial(`adrMat_${key}`, this.scene)
    mat.diffuseColor = farbe
    mat.emissiveColor = farbe.scale(0.6)
    // Eine geschätzte Lage sieht auch geschätzt aus: blasser und durchscheinend.
    if (!genau) mat.alpha = 0.55

    const pfeiler = BABYLON.MeshBuilder.CreateCylinder(`adrPole_${key}`,
      { height: PFEILER_H, diameter: 0.04, tessellation: 6 }, this.scene)
    pfeiler.position.y = PFEILER_H / 2
    pfeiler.material = mat
    pfeiler.isPickable = false
    pfeiler.parent = node

    const fuss = BABYLON.MeshBuilder.CreateDisc(`adrBase_${key}`,
      { radius: 0.25, tessellation: 20 }, this.scene)
    fuss.rotation.x = Math.PI / 2
    fuss.position.y = 0.02
    fuss.material = mat
    fuss.isPickable = false
    fuss.parent = node

    const tafel = this._tafel(key, a, gross)
    if (tafel) tafel.parent = node
    return { node, tafel }
  }

  /** Auf- oder zuklappen — angetippt. */
  _umschalten(key) {
    const e = this._marker.get(key)
    if (!e?.node) return
    const gross = !e.gross
    if (gross) for (const k of [...this._marker.keys()]) if (k !== key) this._klappe(k, false)
    this._klappe(key, gross)
  }

  /**
   * Tafel tauschen. Der Pfeiler bleibt stehen — nur dieses eine Mesh wird neu
   * gebaut, damit weder Position noch Höhenbezug neu gerechnet werden müssen.
   */
  _klappe(key, gross) {
    const e = this._marker.get(key)
    if (!e?.node || !!e.gross === !!gross) return
    try { e.tafel?.dispose(false, true) } catch {}
    e.tafel = this._tafel(key, e.daten, gross)
    if (e.tafel) e.tafel.parent = e.node
    e.gross = !!gross
  }

  _alleZuklappen() { for (const k of [...this._marker.keys()]) this._klappe(k, false) }

  /** Ist gerade eine Tafel aufgeklappt? (Für Tests und Diagnose.) */
  get offeneTafel() {
    for (const [k, e] of this._marker) if (e.gross) return k
    return null
  }

  _tafel(key, a, gross) {
    const genau = a.genauigkeit === 'genau'
    const bild = gross ? this._bildGross(key, a, genau) : this._bildKlein(key, a, genau)
    if (!bild) return null
    const { dt, B, H } = bild

    const breiteM = gross ? TAFEL_B_GROSS : TAFEL_B
    const hoeheM = breiteM * H / B
    const plane = BABYLON.MeshBuilder.CreatePlane(`adrLblPlane_${key}`,
      { width: breiteM, height: hoeheM }, this.scene)
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    // ANTIPPBAR — das ist der ganze Zweck der zweiten Stufe. Der Pfeiler bleibt
    // es nicht: Eine dünne Stange zu treffen ist Glückssache, die Tafel nicht.
    plane.isPickable = true
    plane.metadata = { adressTafel: key }
    // Die Unterkante sitzt auf dem Pfeilerkopf — so wächst die Tafel beim
    // Aufklappen nach OBEN und schiebt sich nicht in den Boden.
    plane.position.y = PFEILER_H + hoeheM / 2

    const lm = new BABYLON.StandardMaterial(`adrLblMat_${key}`, this.scene)
    lm.diffuseTexture = dt
    lm.opacityTexture = dt
    lm.emissiveColor = new BABYLON.Color3(1, 1, 1)
    lm.backFaceCulling = false
    lm.disableLighting = true
    plane.material = lm
    return plane
  }

  /**
   * Zusammengeklappt: Titel, die aussagekräftigste Zeile, ein Zähler für den
   * Rest. Der Zähler sagt zugleich, dass es sich lohnt zu tippen.
   */
  _bildKlein(key, a, genau) {
    const wichtig = (a.felder || []).find(f => f.feld === 'Firma')
                 || (a.felder || []).find(f => f.feld === 'Name')
                 || (a.felder || []).find(f => f.feld === 'Eintrag')
    const rest = Math.max(0, (a.felder || []).length - (wichtig ? 1 : 0))
    const zeile2 = wichtig ? wichtig.wert : (a.ort || '')
    const zeile3 = rest ? `+${rest} Angabe(n) · antippen`
                        : (genau ? (a.felder || []).length ? 'antippen' : '' : 'Lage geschätzt')

    const B = 512, H = 192
    const dt = new BABYLON.DynamicTexture(`adrLbl_${key}`, { width: B, height: H }, this.scene, true)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, B, H)
    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    ctx.fillRect(0, 0, B, H)
    ctx.textAlign = 'center'
    ctx.font = 'bold 44px sans-serif'
    ctx.fillStyle = genau ? '#ffd479' : '#c5c9ce'
    ctx.fillText(this._kuerzen(ctx, a.titel || 'Adresse', B - 24), B / 2, 56)
    ctx.font = '34px sans-serif'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(this._kuerzen(ctx, zeile2, B - 24), B / 2, 110)
    if (zeile3) {
      ctx.font = '28px sans-serif'
      ctx.fillStyle = '#b9c0c7'
      ctx.fillText(zeile3, B / 2, 158)
    }
    dt.update()
    return { dt, B, H }
  }

  /**
   * Aufgeklappt: alles, was der Agent geliefert hat — je Angabe die Herkunft
   * darunter. Ohne sie wäre die Tafel eine Behauptung; mit ihr ist sie eine
   * Vorführung, und genau darum geht es bei diesem Werkzeug.
   */
  _bildGross(key, a, genau) {
    const roh = []
    roh.push({ art: 'titel', text: a.titel || 'Adresse' })
    const kopf = [a.ort, Number.isFinite(a.entfernungM) ? `${a.entfernungM} m` : null]
      .filter(Boolean).join('  ·  ')
    if (kopf) roh.push({ art: 'kopf', text: kopf })
    if (!genau) roh.push({ art: 'notiz', text: 'Lage geschätzt' })

    const felder = a.felder || []
    if (!felder.length) roh.push({ art: 'notiz', text: '— keine weiteren öffentlichen Angaben' })
    let hatVerweis = false
    for (const f of felder) {
      if (f.link) hatVerweis = true
      const wert = f.link ? String(f.wert || '').replace(/^https?:\/\//, '') : f.wert
      roh.push({ art: 'feld', text: `${f.ausfall ? '⚠' : '·'} ${f.feld}: ${wert}` })
      if (f.herkunft) roh.push({ art: 'herkunft', text: `↳ ${f.herkunft}` })
    }
    // Ein Verweis in einer Textur lässt sich nicht anklicken — also dorthin
    // zeigen, wo er es kann, statt eine Schaltfläche vorzutäuschen.
    if (hatVerweis) roh.push({ art: 'fuss', text: 'Verweise lassen sich im Verlaufsfenster öffnen.' })
    roh.push({ art: 'fuss', text: 'Flüchtig — wird nicht gespeichert. Tippen schliesst.' })

    const B = 1024
    // ERST MESSEN, DANN MALEN: Wie hoch die Tafel wird, hängt vom Umbruch ab —
    // und die Größe einer DynamicTexture steht beim Anlegen fest. Also ein
    // Wegwerf-Bild, das nur zum Messen lebt.
    let umbrochen = roh.map(z => ({ ...z }))
    let mess = null
    try {
      mess = new BABYLON.DynamicTexture(`adrMess_${key}`, { width: 8, height: 8 }, this.scene, false)
      const mctx = mess.getContext()
      umbrochen = []
      for (const z of roh) {
        mctx.font = SCHRIFT[z.art].font
        for (const t of this._umbrechen(mctx, z.text, B - RAND * 2)) umbrochen.push({ art: z.art, text: t })
      }
    } catch { /* ohne Messung bleibt es bei den ungebrochenen Zeilen */ }
    try { mess?.dispose() } catch {}

    if (umbrochen.length > MAX_ZEILEN) {
      umbrochen = umbrochen.slice(0, MAX_ZEILEN)
      umbrochen.push({ art: 'notiz', text: '… weiter im Verlaufsfenster' })
    }

    let H = RAND * 2
    for (const z of umbrochen) H += SCHRIFT[z.art].zeile
    H = Math.max(192, Math.ceil(H / 8) * 8)

    const dt = new BABYLON.DynamicTexture(`adrLbl_${key}`, { width: B, height: H }, this.scene, true)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, B, H)
    ctx.fillStyle = 'rgba(0,0,0,0.78)'
    ctx.fillRect(0, 0, B, H)
    ctx.textAlign = 'left'
    let y = RAND
    for (const z of umbrochen) {
      const s = SCHRIFT[z.art]
      ctx.font = s.font
      ctx.fillStyle = s.farbe || (genau ? '#ffd479' : '#c5c9ce')
      y += s.zeile
      ctx.fillText(z.text, RAND, y - Math.round(s.zeile * 0.25))
    }
    dt.update()
    return { dt, B, H }
  }

  /**
   * Text auf die Breite umbrechen. Ein einzelnes Wort, das nicht passt (eine
   * lange Web-Adresse), wird hart getrennt — abgeschnitten wäre hier falsch,
   * weil die Adresse dann nicht mehr stimmt.
   */
  _umbrechen(ctx, text, maxBreite) {
    const raus = []
    let zeile = ''
    for (const wort of String(text ?? '').split(' ')) {
      const versuch = zeile ? `${zeile} ${wort}` : wort
      if (ctx.measureText(versuch).width <= maxBreite) { zeile = versuch; continue }
      if (zeile) { raus.push(zeile); zeile = '' }
      let rest = wort
      while (rest.length > 1 && ctx.measureText(rest).width > maxBreite) {
        let n = rest.length
        while (n > 1 && ctx.measureText(rest.slice(0, n)).width > maxBreite) n--
        raus.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      zeile = rest
    }
    if (zeile) raus.push(zeile)
    return raus.length ? raus : ['']
  }

  /** Text auf die Breite bringen — abgeschnitten ist besser als übergelaufen. */
  _kuerzen(ctx, text, maxBreite) {
    let s = String(text ?? '')
    if (ctx.measureText(s).width <= maxBreite) return s
    while (s.length > 1 && ctx.measureText(s + '…').width > maxBreite) s = s.slice(0, -1)
    return s + '…'
  }

  // ── Karte ───────────────────────────────────────────────────────────────

  _zeichneKarte(key, a) {
    const genau = a.genauigkeit === 'genau'
    const m = this.L.circleMarker([a.lat, a.lon], {
      radius: 7,
      color: genau ? '#ffd479' : '#9aa0a6',
      weight: 2,
      // Gestrichelt = geschätzte Lage. Der Unterschied muss sichtbar sein,
      // nicht nur im Text stehen.
      dashArray: genau ? null : '3,3',
      fillColor: genau ? '#ffd479' : '#9aa0a6',
      fillOpacity: genau ? 0.5 : 0.25,
    })
    m.bindPopup(this._popup(a))
    this._layer.addLayer(m)
    return m
  }

  _popup(a) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const kopf = `<b>${esc(a.titel)}</b>${a.ort ? `<br><span style="opacity:.75">${esc(a.ort)}</span>` : ''}`
    const hinweis = a.genauigkeit === 'genau' ? ''
      : '<div style="opacity:.7;font-style:italic">Lage geschätzt</div>'
    const zeilen = (a.felder || []).map(f => {
      // NUR als Link, wenn der Agent das Feld ausdrücklich so gekennzeichnet
      // hat — nicht, weil ein Wert nach einer Adresse aussieht.
      const wert = f.link && /^https:\/\//.test(f.wert)
        ? `<a href="${esc(f.wert)}" target="_blank" rel="noopener noreferrer">Eintrag öffnen</a>`
        : esc(f.wert)
      return `<div>${f.ausfall ? '⚠' : '·'} ${esc(f.feld)}: ${wert}` +
             `<br><span style="opacity:.6;font-size:.85em">${esc(f.herkunft)}</span></div>`
    }).join('')
    const fuss = '<div style="opacity:.6;font-size:.85em;margin-top:.4em">' +
                 'Flüchtig — wird nicht gespeichert.</div>'
    return `<div style="max-height:40vh;overflow:auto">${kopf}${hinweis}${zeilen || '<div>— keine weiteren Angaben</div>'}${fuss}</div>`
  }

  dispose() {
    try {
      const alle = (typeof window !== 'undefined' && window.ajnaAdressMarkers) || null
      if (alle) {
        const i = alle.indexOf(this)
        if (i >= 0) alle.splice(i, 1)
      }
    } catch {}
    for (const off of this._offs) { try { off?.() } catch {} }
    this._offs = []
    try { if (this._zeigerObs) this.scene?.onPointerObservable.remove(this._zeigerObs) } catch {}
    this._zeigerObs = null
    this.leeren()
    try { this._root?.dispose() } catch {}
    try { if (this._layer && this.map) this.map.removeLayer(this._layer) } catch {}
  }
}
