// gangart — welche Bewegungs-Animation, wie stark, wie schnell abgespielt.
//
// DAS EIGENTLICHE PROBLEM ist nicht, dass Figuren dumm wirken, sondern dass sie
// GLEITEN. Ein Gehzyklus ist für ein bestimmtes Tempo gezeichnet; läuft die
// Figur schneller, als die Füße treten, rutscht sie über den Boden — und das
// liest jeder sofort als „Puppe, die geschoben wird". Umgekehrt trippelt sie
// auf der Stelle. Kein noch so kluges Verhalten repariert diesen Eindruck.
//
// Die Rechnung dagegen ist einfach: Abspieltempo = tatsächliches Tempo geteilt
// durch das Tempo, für das der Zyklus gezeichnet wurde. Was bisher fehlte, war
// nicht die Formel, sondern die ZAHL — der Client kannte die Geschwindigkeit
// gar nicht. Er bekam alle 500 ms eine neue Position und musste raten.
//
// Seit die Agents ihren Bewegungsplan veröffentlichen (`state.motion`, siehe
// agents/lib/bewegung.mjs), steht sie dort: `v` in Metern pro Sekunde.
//
// DAS ZYKLUS-TEMPO KOMMT AUS DEM MODELL-PROFIL, nicht aus einer Schätzung.
// Es steht als `appearance.gehTempo` am Objekt: für welches Tempo der Gehzyklus
// dieses Modells gezeichnet ist.
//
// Der erste Entwurf leitete es aus der FIGURENGRÖSSE ab — das war falsch. Ein
// Zyklus wird nicht langsamer, weil man das Modell kleiner skaliert. Beim Fuchs
// kam so 0,47 m/s heraus statt 0,92; das Abspieltempo lief in den Anschlag, und
// er lief auf der Stelle. Die Größe sagt über die Zeichnung eines Clips nichts.
//
// Diese Datei ist bewusst frei von Babylon: Sie rechnet nur, und genau das
// lässt sich ohne Browser prüfen.

/** Ab hier gilt die Figur als stehend (m/s). */
export const STEHT_UNTER = 0.15

/** Für welches Tempo ein Gehzyklus üblicherweise gezeichnet ist (m/s, Mensch). */
export const GEH_TEMPO = 1.4

/** Dasselbe für einen Laufzyklus. */
export const LAUF_TEMPO = 4.0

/**
 * Wie weit das Abspieltempo verstellt werden darf.
 *
 * Jenseits davon sieht die Figur albern aus (Zeitlupe bzw. Trickfilm-Trippeln).
 * Dann lieber ein wenig Gleiten in Kauf nehmen: Ein zu schnell abgespielter
 * Zyklus fällt stärker auf als ein leichter Versatz.
 */
export const TEMPO_MIN = 0.55
export const TEMPO_MAX = 1.9

/**
 * Wie schnell die geschätzte Geschwindigkeit steigen darf (m/s²).
 *
 * Nur für den Rückfall ohne Bewegungsplan. Ein Sprinter erreicht etwa 3 m/s²;
 * mit 4 bleibt Luft für Fahrzeuge, ohne dass ein einzelner Positionssprung die
 * Figur in den Sprint schickt.
 */
export const MAX_BESCHLEUNIGUNG = 4

const klemme = (v, a, b) => Math.min(b, Math.max(a, v))

/**
 * Gangart aus dem tatsächlichen Tempo.
 *
 * @param {number} v          Geschwindigkeit über Grund (m/s)
 * @param {{
 *   gehTempo?: number,       Tempo, für das der Gehzyklus gezeichnet ist
 *   laufTempo?: number,
 *   hatLauf?: boolean,       Bringt das Modell einen Laufzyklus mit?
 * }} [opts]
 * @returns {{
 *   zustand: 'idle'|'walk'|'run',
 *   misch: {von: string, nach: string, anteil: number},
 *   tempo: number,           Abspielfaktor für den führenden Zyklus
 *   gleitet: number,         Restlicher Versatz als Faktor (1 = kein Gleiten)
 * }}
 */
export function gangartFuer(v, {
  gehTempo = GEH_TEMPO,
  laufTempo = null,
  hatLauf = true,
} = {}) {
  const tempoV = Math.max(0, Number(v) || 0)
  const gehen = Math.max(0.1, Number(gehTempo) || GEH_TEMPO)
  // Ohne eigene Angabe: Ein Laufzyklus deckt üblicherweise das Knapp-Dreifache
  // des Gehzyklus ab. Aus dem Verhältnis abgeleitet statt aus einer absoluten
  // Zahl — sonst liefe ein Pferd bei 2 m/s schon im „Sprint".
  const laufen = Number.isFinite(laufTempo) && laufTempo > gehen
    ? laufTempo
    : gehen * (LAUF_TEMPO / GEH_TEMPO)

  if (tempoV < STEHT_UNTER) {
    return { zustand: 'idle', misch: { von: 'idle', nach: 'idle', anteil: 0 },
             tempo: 1, tempoFuer: { walk: 1, run: 1, idle: 1 }, gleitet: 1 }
  }

  // Ganz langsam: zwischen Stand und Gehen überblenden, statt den Gehzyklus in
  // Zeitlupe abzuspielen. Ein sehr langsamer Gehzyklus sieht aus wie ein Fehler.
  if (tempoV < gehen * 0.5) {
    const anteil = tempoV / (gehen * 0.5)
    return {
      zustand: 'walk',
      misch: { von: 'idle', nach: 'walk', anteil },
      tempo: klemme(tempoV / gehen, TEMPO_MIN, TEMPO_MAX),
      tempoFuer: tempoTabelle(tempoV, gehen, laufen),
      gleitet: gleitFaktor(tempoV, gehen),
    }
  }

  if (!hatLauf || tempoV <= gehen) {
    return {
      zustand: 'walk',
      misch: { von: 'walk', nach: 'walk', anteil: 0 },
      tempo: klemme(tempoV / gehen, TEMPO_MIN, TEMPO_MAX),
      tempoFuer: tempoTabelle(tempoV, gehen, laufen),
      gleitet: gleitFaktor(tempoV, gehen),
    }
  }

  if (tempoV >= laufen) {
    return {
      zustand: 'run',
      misch: { von: 'run', nach: 'run', anteil: 0 },
      tempo: klemme(tempoV / laufen, TEMPO_MIN, TEMPO_MAX),
      tempoFuer: tempoTabelle(tempoV, gehen, laufen),
      gleitet: gleitFaktor(tempoV, laufen),
    }
  }

  // Dazwischen: Gehen und Laufen mischen. Der Übergang ist der Bereich, in dem
  // ein harter Wechsel am meisten stört.
  //
  // ACHTUNG, hier lag ein Denkfehler: Zuerst wurde das Abspieltempo gegen ein
  // INTERPOLIERTES Bezugstempo gerechnet — und das ergibt zwangsläufig immer
  // 1,0, weil der Bezug per Konstruktion dem Ist-Tempo entspricht. Im gesamten
  // Misch-Bereich fand also gar keine Anpassung statt, und dort leben die
  // meisten Figuren. Genau das war als „Füße rutschen" zu sehen.
  //
  // Solange nur EIN Zyklus abgespielt wird (echtes Gewichte-Blending gibt es
  // nicht), muss das Tempo zu genau DIESEM Zyklus passen. Deshalb beide Werte
  // ausweisen; wer führt, entscheidet der Aufrufer (er kennt seine Hysterese).
  const anteil = (tempoV - gehen) / (laufen - gehen)
  const zustand = anteil > 0.5 ? 'run' : 'walk'
  const bezug = zustand === 'run' ? laufen : gehen
  return {
    zustand,
    misch: { von: 'walk', nach: 'run', anteil },
    tempo: klemme(tempoV / bezug, TEMPO_MIN, TEMPO_MAX),
    tempoFuer: {
      walk: klemme(tempoV / gehen, TEMPO_MIN, TEMPO_MAX),
      run: klemme(tempoV / laufen, TEMPO_MIN, TEMPO_MAX),
      idle: 1,
    },
    gleitet: gleitFaktor(tempoV, bezug),
  }
}

/** Abspieltempo je möglichem Zyklus — der Aufrufer wählt, welcher führt. */
function tempoTabelle(v, gehen, laufen) {
  return {
    walk: klemme(v / gehen, TEMPO_MIN, TEMPO_MAX),
    run: klemme(v / laufen, TEMPO_MIN, TEMPO_MAX),
    idle: 1,
  }
}

/**
 * Wie stark die Figur trotz Anpassung noch gleitet.
 * 1 = gar nicht. Nur zur Diagnose — sichtbar wird es ohnehin.
 */
function gleitFaktor(v, bezug) {
  const noetig = v / bezug
  const moeglich = klemme(noetig, TEMPO_MIN, TEMPO_MAX)
  return moeglich === 0 ? 1 : noetig / moeglich
}

/**
 * Tempo aus zwei Positionsmeldungen schätzen — für Objekte OHNE Bewegungsplan.
 *
 * Bewusst als Rückfall gekennzeichnet: Aus zwei Punkten und der Zeit dazwischen
 * lässt sich ein Tempo errechnen, aber es zappelt (Netzjitter schlägt voll
 * durch) und hinkt immer ein Update hinterher. Wo `state.motion` vorliegt, ist
 * die Angabe des Agents immer besser.
 *
 * @returns {number} m/s, geglättet
 */
export function tempoAusSpruengen(vorher, jetzt, dtMs, letztes = 0, glaettung = 0.35) {
  if (!vorher || !jetzt || !(dtMs > 0)) return letztes
  const dLat = (jetzt.lat - vorher.lat) * 111320
  const dLon = (jetzt.lon - vorher.lon) * 111320 * Math.cos(vorher.lat * Math.PI / 180)
  const roh = Math.sqrt(dLat * dLat + dLon * dLon) / (dtMs / 1000)
  if (!Number.isFinite(roh)) return letztes

  const dt = dtMs / 1000
  const geglaettet = letztes + (Math.min(roh, 40) - letztes) * klemme(glaettung, 0, 1)
  // Ein Tiefpass allein wehrt Ausreißer NICHT ab — er dämpft sie nur. Ein
  // einzelner Positionssprung (Netzhänger, GPS-Sprung, Teleport durch den
  // Editor) schob die Schätzung trotzdem auf zweistellige Werte, und die Figur
  // fiel für ein paar Sekunden in den Sprint. Deshalb zusätzlich eine Schranke
  // für die BESCHLEUNIGUNG: Was schneller zunimmt, als ein Lebewesen
  // beschleunigen kann, ist keine Bewegung, sondern ein Messfehler.
  const grenze = MAX_BESCHLEUNIGUNG * dt
  return klemme(geglaettet, letztes - grenze, letztes + grenze)
}
