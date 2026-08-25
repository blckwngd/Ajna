// aktionsReichweite — „nur vor Ort", und was das für die Privatsphäre heißt.
//
// Eine Aktion in `state.actions` kann eine Reichweite tragen:
//
//   { key: 'attack', label: 'Angreifen', max_distance: 30 }
//
// Ab da gilt sie nur noch in der Nähe des Objekts. Fehlt die Angabe (oder ist
// sie 0), gibt es keine Einschränkung — bestehende Objekte ändern ihr Verhalten
// also nicht.
//
// DER PUNKT, DER DIESE DATEI RECHTFERTIGT: Nähe lässt sich nur prüfen, wenn der
// Spieler seinen Standort überhaupt preisgibt. Die Stufen (siehe
// PrivacyPolicy.js) geben unterschiedlich viel her:
//
//   Verborgen  gar nichts                        → keine Nähe feststellbar
//   Gegend     Position auf ~100 m gerundet      → grobe Prüfung möglich
//   Nähe       „jemand ist an DIESEM Objekt"     → genau das, worum es geht
//   Genau      exakte Position                   → beliebig feine Prüfung
//
// Daraus folgt die Regel, und zwar aus der Sache heraus statt willkürlich: Wer
// eine Reichweite UNTER dem Rundungsraster prüfen will, braucht mindestens
// „Nähe". Eine auf 100 m gerundete Position kann eine 30-m-Frage nicht
// beantworten — sie würde sie raten.
//
// DER TAUSCH IST BEWUSST UND NACHVOLLZIEHBAR: Wer kämpfen will, muss für den
// Kampf die Deckung fallen lassen. Niemand wird dazu gedrängt; die Aktion ist
// dann eben nicht verfügbar, mit sichtbarer Begründung. Und ein Objekt, das
// ohne Nähe auskommt, setzt einfach keine Reichweite.
//
// Diese Datei rechnet nur. Der Client entscheidet damit, ob er den Menüpunkt
// anbietet; der Agent prüft damit, was bei ihm ankommt. Beide Seiten müssen
// dieselbe Antwort geben — deshalb steht sie an einer Stelle.

/**
 * Unterhalb dieser Reichweite reicht eine gerundete Position nicht mehr.
 * Entspricht dem Rundungsraster der Stufe „Gegend" (FUZZ_GRID_M = 100) mit
 * reichlich Sicherheitsabstand: Eine 400-m-Frage mit 100-m-Rundung zu
 * beantworten hieße, sich in jedem vierten Fall zu irren.
 */
export const FEIN_AB_M = 500

/** Rangfolge wie in PrivacyPolicy — hier gespiegelt, damit diese Datei allein steht. */
const RANG = { off: 0, area: 1, proximity: 2, exact: 3 }

/** Reichweite einer Aktion, oder 0 wenn keine gesetzt ist. */
export function reichweiteVon(aktion) {
  const m = Number(aktion?.max_distance)
  return Number.isFinite(m) && m > 0 ? m : 0
}

/**
 * Welche Standort-Stufe diese Aktion mindestens verlangt.
 * @returns {'off'|'area'|'proximity'} `off` = keine Anforderung
 */
export function noetigeStufe(aktion) {
  const m = reichweiteVon(aktion)
  if (!m) return 'off'
  return m < FEIN_AB_M ? 'proximity' : 'area'
}

/** Reicht die eingestellte Stufe für diese Aktion? */
export function stufeReicht(aktion, stufe) {
  const noetig = noetigeStufe(aktion)
  if (noetig === 'off') return true
  return (RANG[stufe] ?? 0) >= RANG[noetig]
}

/**
 * Darf der Spieler diese Aktion auslösen?
 *
 * Getrennt nach GRUND, damit die Oberfläche sagen kann, was zu tun ist. Ein
 * ausgegrauter Knopf ohne Erklärung ist eine Sackgasse.
 *
 * @param {object} aktion   Eintrag aus `state.actions`
 * @param {string} stufe    eingestellte Standort-Stufe für diesen Server
 * @param {number|null} entfernungM  gemessene Entfernung, falls bekannt
 * @returns {{ok: boolean, grund: 'frei'|'stufe'|'zu-weit', noetig: string, text: string}}
 */
export function aktionErlaubt(aktion, stufe, entfernungM = null) {
  const m = reichweiteVon(aktion)
  if (!m) return { ok: true, grund: 'frei', noetig: 'off', text: '' }

  const noetig = noetigeStufe(aktion)
  if (!stufeReicht(aktion, stufe)) {
    return {
      ok: false, grund: 'stufe', noetig,
      text: noetig === 'proximity'
        ? `Nur aus der Nähe möglich. Dafür muss die Standort-Freigabe auf „Nähe" oder „Genau" stehen.`
        : `Nur in der Gegend möglich. Dafür muss die Standort-Freigabe mindestens auf „Gegend" stehen.`,
    }
  }

  // Ohne gemessene Entfernung wird NICHT abgelehnt: Bei Stufe „Nähe" gibt es
  // gar keine Koordinaten, nur die Meldung „jemand ist an diesem Objekt" —
  // und die ist die Antwort, nicht ihr Ersatz. Geprüft wird dann beim Agent.
  if (Number.isFinite(entfernungM) && entfernungM > m) {
    return {
      ok: false, grund: 'zu-weit', noetig,
      text: `Zu weit weg — höchstens ${m} m (aktuell ${Math.round(entfernungM)} m).`,
    }
  }
  return { ok: true, grund: 'frei', noetig, text: '' }
}

/** Entfernung in Metern (äquirektangular — auf diesen Skalen genau genug). */
export function abstandM(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return NaN
  const dLat = (bLat - aLat) * 111320
  const dLon = (bLon - aLon) * 111320 * Math.cos((aLat + bLat) / 2 * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

/**
 * Agent-Seite: Ist der Auslöser nah genug?
 *
 * Der Agent bekommt je nach Stufe Verschiedenes — eine Position, eine
 * Nähe-Meldung, oder nichts. Diese Funktion nimmt beides entgegen und
 * entscheidet daraus, statt jeden Agent dieselbe Fallunterscheidung neu bauen
 * zu lassen.
 *
 * @param {object} o
 * @param {object} o.aktion       Eintrag aus `state.actions`
 * @param {{lat:number, lon:number}|null} o.ziel      Position des Objekts
 * @param {{lat:number, lon:number}|null} o.absender  mitgeschickte Position (evtl. gerundet)
 * @param {boolean} o.istNah      meldet der Nähe-Melder den Spieler an diesem Objekt?
 * @returns {{ok: boolean, grund: string, entfernungM: number|null}}
 */
export function naheGenug({ aktion, ziel, absender, istNah = false }) {
  const m = reichweiteVon(aktion)
  if (!m) return { ok: true, grund: 'ohne-reichweite', entfernungM: null }

  // Die Nähe-Meldung ist die BESTE Auskunft, nicht die schlechteste: Sie sagt
  // genau das, was gefragt ist, ohne eine Koordinate preiszugeben.
  if (istNah) return { ok: true, grund: 'naehe-gemeldet', entfernungM: null }

  const d = absender && ziel ? abstandM(ziel.lat, ziel.lon, absender.lat, absender.lon) : NaN
  if (!Number.isFinite(d)) return { ok: false, grund: 'keine-position', entfernungM: null }

  // Kulanz für die Rundung der Stufe „Gegend": Ohne sie läge jeder, der auf
  // dem Raster gerundet meldet, systematisch zu weit daneben.
  const kulanz = noetigeStufe(aktion) === 'area' ? 150 : 0
  if (d > m + kulanz) return { ok: false, grund: 'zu-weit', entfernungM: d }
  return { ok: true, grund: 'in-reichweite', entfernungM: d }
}
