// himmel.mjs — Mondphase und Tageszeit als SPRECHFERTIGE Werte.
//
// WOFÜR: Parley rechnet nicht, es setzt ein. Soll eine Figur nachts sagen
// „Der Himmel ist klar, man sieht den zunehmenden Halbmond", dann muss die
// Zeichenkette `zunehmender Halbmond` als Variable vorliegen. Die Uhrzeit zu
// kennen nützt einer Mustermaschine nichts (siehe docs/welt-kontext.md).
//
// WARUM OHNE NETZ: Mondphase und Tageszeit sind Arithmetik. Sie über eine
// fremde API zu holen hiesse, für etwas Bekanntes ein Kontingent zu verbrennen
// und von der Erreichbarkeit eines Dritten abhängig zu sein — bei einer Zahl,
// die sich in einer Zeile ausrechnen lässt.
//
// ABGRENZUNG ZUM CLIENT: Der Client rechnet den Sonnenstand für Licht und
// Schatten selbst, in voller Genauigkeit. Hier geht es nicht um Darstellung,
// sondern um Sätze. Zwei Verbraucher, zwei Bedürfnisse.
//
// GENAUIGKEIT, ehrlich gesagt: Die Mondphase läuft über die mittlere synodische
// Periode. Das ist auf etwa einen halben Tag genau — die echte Umlaufzeit
// schwankt um bis zu sieben Stunden. Für „zunehmender Halbmond" reicht das
// mühelos; für eine Sternwarte nicht. Wer Letzteres braucht, holt sich eine
// Ephemeriden-Bibliothek und ersetzt genau diese eine Funktion.

/** Mittlere Länge eines Mondmonats (Neumond zu Neumond), in Tagen. */
const SYNODISCH = 29.530588853

/** Ein bekannter Neumond als Nullpunkt: 6. Januar 2000, 18:14 UTC. */
const NEUMOND_NULL = Date.UTC(2000, 0, 6, 18, 14) / 86400000

// Acht Phasen. Die vier „runden" (Neumond, Halbmonde, Vollmond) gelten nur
// nahe ihrem Punkt — sonst hiesse die Hälfte des Monats „Halbmond", und eine
// Figur, die drei Tage lang vom Halbmond spricht, wirkt nicht beobachtend,
// sondern kaputt.
const NAH = 0.02   // ±0,02 Umlauf ≈ ±14 Stunden

/**
 * Mondphase zu einem Zeitpunkt.
 *
 * @param {Date|number} [zeit]
 * @returns {{anteil: number, name: string, beleuchtet: number, zunehmend: boolean}}
 *   `anteil` 0…1 (0 = Neumond, 0,5 = Vollmond), `beleuchtet` 0…1 als Anteil der
 *   sichtbaren Scheibe, `name` sprechfertig im Nominativ.
 */
export function mondphase(zeit = new Date()) {
  const tage = (zeit instanceof Date ? zeit.getTime() : Number(zeit)) / 86400000
  let anteil = ((tage - NEUMOND_NULL) / SYNODISCH) % 1
  if (anteil < 0) anteil += 1

  // Beleuchteter Anteil der Scheibe — Kosinus, nicht linear: Zwischen „halb"
  // und „voll" ändert sich sichtbar weniger als um den Neumond herum.
  const beleuchtet = (1 - Math.cos(2 * Math.PI * anteil)) / 2
  const zunehmend = anteil < 0.5

  let name
  if (anteil < NAH || anteil > 1 - NAH)            name = 'Neumond'
  else if (Math.abs(anteil - 0.25) < NAH)          name = 'zunehmender Halbmond'
  else if (Math.abs(anteil - 0.5) < NAH)           name = 'Vollmond'
  else if (Math.abs(anteil - 0.75) < NAH)          name = 'abnehmender Halbmond'
  else if (anteil < 0.25)                          name = 'zunehmende Mondsichel'
  else if (anteil < 0.5)                           name = 'zunehmender Mond'
  else if (anteil < 0.75)                          name = 'abnehmender Mond'
  else                                             name = 'abnehmende Mondsichel'

  return { anteil, name, beleuchtet, zunehmend }
}

/**
 * Tageszeit als Wort — an der SONNE ausgerichtet, nicht an der Uhr.
 *
 * WARUM NICHT EINFACH DIE STUNDE: Um 18 Uhr ist es im Juni hell und im Dezember
 * dunkel. Eine Figur, die im Dezember um 17 Uhr „Nachmittag" sagt, während der
 * Spieler im Finstern steht, hat sich gerade als Kulisse zu erkennen gegeben.
 *
 * Ohne Sonnenzeiten (Quelle nicht erreichbar) fällt es auf die Uhr zurück —
 * ungenau, aber nie falsch genug, um aufzufallen.
 *
 * @param {Date} [zeit]
 * @param {{sonnenaufgang?: Date|string, sonnenuntergang?: Date|string}} [sonne]
 * @returns {'Nacht'|'Morgen'|'Vormittag'|'Mittag'|'Nachmittag'|'Abend'}
 */
export function tageszeit(zeit = new Date(), sonne = {}) {
  const t = zeit instanceof Date ? zeit : new Date(zeit)
  const auf = zeitOderNull(sonne.sonnenaufgang)
  const unter = zeitOderNull(sonne.sonnenuntergang)
  const stunde = t.getHours() + t.getMinutes() / 60

  if (auf && unter) {
    const aufH = auf.getHours() + auf.getMinutes() / 60
    const unterH = unter.getHours() + unter.getMinutes() / 60
    if (stunde < aufH - 0.5 || stunde > unterH + 0.5) return 'Nacht'
    // Die helle Zeit in vier Teile — nicht gleich lang, sondern so, wie Leute
    // sprechen: Der „Mittag" ist ein schmales Fenster, der Nachmittag lang.
    const spanne = Math.max(1, unterH - aufH)
    const rel = (stunde - aufH) / spanne
    if (rel < 0.15) return 'Morgen'
    if (rel < 0.40) return 'Vormittag'
    if (rel < 0.55) return 'Mittag'
    if (rel < 0.85) return 'Nachmittag'
    return 'Abend'
  }

  if (stunde < 5)  return 'Nacht'
  if (stunde < 9)  return 'Morgen'
  if (stunde < 11) return 'Vormittag'
  if (stunde < 14) return 'Mittag'
  if (stunde < 18) return 'Nachmittag'
  if (stunde < 22) return 'Abend'
  return 'Nacht'
}

/** „07:17" aus einem Zeitpunkt — die Form, die eine Figur aussprechen kann. */
export const uhrzeit = (wert) => {
  const t = zeitOderNull(wert)
  if (!t) return ''
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}

/**
 * Alles zusammen als `himmel.*`-Variablen für einen Dialog.
 *
 * NOMINATIV, keine Beugung: „{himmel.mond}" steht in einem Satz wie
 * „Heute Nacht: {himmel.mond}." — nicht „man sieht den {himmel.mond}". Deutsche
 * Fälle im Platzhalter nachzubauen hiesse, eine Grammatik in eine
 * Mustermaschine zu bauen; das kostet mehr, als es einbringt. Wer den Akkusativ
 * braucht, schreibt den Satz um.
 */
export function himmelVars(zeit = new Date(), sonne = {}) {
  const m = mondphase(zeit)
  return {
    mond: m.name,
    mond_anteil: Math.round(m.beleuchtet * 100),
    tageszeit: tageszeit(zeit, sonne),
    nacht: tageszeit(zeit, sonne) === 'Nacht',
    sonnenaufgang: uhrzeit(sonne.sonnenaufgang),
    sonnenuntergang: uhrzeit(sonne.sonnenuntergang),
  }
}

function zeitOderNull(wert) {
  if (!wert) return null
  const t = wert instanceof Date ? wert : new Date(wert)
  return Number.isFinite(t.getTime()) ? t : null
}
