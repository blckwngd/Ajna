import { BaseComponent } from "../BaseComponent.js"

export class CameraComponent extends BaseComponent {

  constructor(canvas) {
    super()
    this.canvas = canvas
    this.camera = null
  }

  init(gameObject) {
    super.init(gameObject)

    // Augenhöhe = reale Höhe der GERÄTE-Kamera über dem Boden. Bestimmt, wo
    // exakt platzierte Objekte (Anker/Marker mit realer Höhe) im Bild erscheinen —
    // deshalb pro Gerät/Person kalibrierbar (Einstellung, live via Event).
    let eye = 1.7
    try { const v = parseFloat(localStorage.getItem('ajna.ar.eye_height')); if (Number.isFinite(v) && v > 0.5 && v < 2.5) eye = v } catch {}

    this.camera = new BABYLON.UniversalCamera(
      "playerCamera",
      new BABYLON.Vector3(0, eye, 0),
      this.scene
    )

    // Live-Änderung (Einstellungs-Feld feuert 'ajna:ar-eye-height' mit Metern).
    this._onEye = ev => {
      const v = parseFloat(ev.detail)
      if (Number.isFinite(v) && v > 0.5 && v < 2.5) this.camera.position.y = v
    }
    try { window.addEventListener('ajna:ar-eye-height', this._onEye) } catch {}

    // Far-Clip weit hinausschieben: der Babylon-Default (maxZ = 10 km) schnitt
    // alles jenseits von 10 km ab — Flugzeuge (ADS-B) bis ~50 km Umkreis
    // verschwanden „hinter einer Wand" (dahinter die infiniteDistance-Skybox).
    // 200 km deckt jeden realistischen ADSB_RADIUS_KM ab. minZ bleibt klein für
    // Nah-Präzision; z-Fighting droht nur bei koplanaren Flächen, die es in der
    // dünn besetzten Szene (Grid, Wireframe-Gebäude, einzelne Figuren) nicht gibt.
    this.camera.maxZ = 200000

    // Bewusst KEIN attachControl: im Non-Debug-Betrieb soll die Kamera
    // fest am Player kleben. Der Debug-Modus aktiviert via Switch-Button
    // bei Bedarf selbst attachControl auf der Player-Kamera.
    this.camera.parent = this.gameObject.root
  }
}