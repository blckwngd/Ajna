// klickDaneben — ein Fenster schließen, wenn jemand DANEBEN klickt.
//
// DER FEHLER, DEN ES BEHEBT
//
// Zwölf Dialoge hatten dieselbe Zeile:
//
//     overlay.addEventListener('click', e => { if (e.target === overlay) close() })
//
// Das sieht richtig aus und ist es nicht. Wer in einem Textfeld Text markiert
// und die Maustaste außerhalb des Fensters loslässt, erzeugt einen `click` —
// und zwar auf dem gemeinsamen Vorfahren beider Punkte, also auf dem Overlay.
// Das Fenster schloss sich mitten im Markieren, samt aller Eingaben.
//
// Auf dem Telefon dasselbe beim Wischen über den Rand hinaus.
//
// DIE REGEL: Geschlossen wird nur, wenn die Geste DANEBEN ANFÄNGT UND DANEBEN
// ENDET. Ein Zug, der im Fenster beginnt, gehört dem Fenster — egal, wo der
// Finger loslässt.
//
// Warum nicht einfach `pointerdown` statt `click`: Dann schlösse das Fenster,
// bevor ein Klick auf einen Knopf am Rand ihn erreicht — und Markieren, das
// daneben beginnt und im Feld endet, würde ebenfalls abgewürgt.

/**
 * @param {HTMLElement} overlay  das abdunkelnde Element HINTER dem Fenster
 * @param {() => void} schliessen
 * @returns {() => void} Abmeldung
 */
export function klickDaneben(overlay, schliessen) {
  if (!overlay || typeof schliessen !== 'function') return () => {}

  // Wo die Geste angefangen hat. `null` heißt: nichts Angefangenes bekannt —
  // dann zählt der Klick nicht, sonst schlösse ein synthetischer Klick ohne
  // vorheriges Drücken das Fenster.
  let start = null

  const runter = (e) => { start = e.target }
  const klick = (e) => {
    const daneben = e.target === overlay && start === overlay
    start = null
    if (daneben) schliessen()
  }

  overlay.addEventListener('pointerdown', runter)
  overlay.addEventListener('click', klick)
  return () => {
    overlay.removeEventListener('pointerdown', runter)
    overlay.removeEventListener('click', klick)
  }
}
