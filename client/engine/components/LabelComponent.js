import { BaseComponent } from "../BaseComponent.js"
import { labelLayerFor } from "../LabelLayer.js"
import { labelOf } from "../../core/Appearance.js"

/**
 * Beschriftung eines Objekts im 3D-Blick (`appearance.label`).
 *
 * Bewusst DÜNN: Text, Größe und die Frage, welche Tafel gerade angeschaut
 * wird, entscheidet die gemeinsame LabelLayer — das geht nur dort, weil es
 * ein Vergleich über ALLE Objekte ist. Diese Komponente liefert nur den
 * Lebenszyklus (kommt und geht mit dem GameObject) und den aktuellen
 * Datensatz, aus dem die Vorlage gefüllt wird.
 *
 * Ohne `appearance.label` meldet sie sich gar nicht erst an — Objekte ohne
 * Beschriftung kosten dann auch nichts.
 */
export class LabelComponent extends BaseComponent {

  constructor(record) {
    super()
    this.record = record
    this._registered = false
  }

  init(gameObject) {
    super.init(gameObject)
    this._sync()
  }

  /** Nach einem Realtime-Update den frischen Datensatz übernehmen. */
  setRecord(record) {
    this.record = record
    this._sync()
  }

  /** An-/abmelden je nachdem, ob der Datensatz gerade eine Vorlage trägt. */
  _sync() {
    const layer = labelLayerFor(this.scene)
    const wanted = !!labelOf(this.record)
    if (wanted) {
      layer.register(this.gameObject, this.record)   // register aktualisiert auch
      this._registered = true
    } else if (this._registered) {
      layer.unregister(this.gameObject)
      this._registered = false
    }
  }

  dispose() {
    if (this._registered) labelLayerFor(this.scene).unregister(this.gameObject)
    this._registered = false
  }
}
