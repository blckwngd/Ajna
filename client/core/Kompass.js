// Kompass — EIN Kurs für alle Ansichten.
//
// WARUM ES DAS BRAUCHT
//
// Die Blickrichtung lag bisher an drei Orten und nirgends greifbar:
//
//   • `MapGpsControl` hörte selbst auf `deviceorientation` — aber nur, solange
//     die große Karte offen war, und behielt den Wert für sich.
//   • Die 3D-Ansicht leitete ihn aus der Kamera ab — nur dort verfügbar.
//   • `window.ajnaHeadingRad` wurde an zwei Stellen GELESEN (Anwesenheit,
//     Minimap) und an keiner einzigen gesetzt. Ein toter Wert, der stumm
//     `null` lieferte.
//
// Folge: Im Objekte-Reiter gab es überhaupt keine Richtung, und die Minimap
// konnte sich nicht drehen. Deshalb hier eine gemeinsame Quelle, die in JEDER
// Ansicht läuft.
//
// GETEILTER ZUSTAND AN `window`: Ajna wird in vier Bündel gepackt, jedes
// bekommt seine eigene Modulinstanz. Ein Kompass je Bündel hieße: mehrfach
// dieselben Sensor-Ereignisse abonnieren und trotzdem verschiedene Werte
// halten. Dasselbe Muster wie bei `window.ajnaLog` und `window.__ajnaI18n`.
//
// GLÄTTUNG: Rohwerte springen um mehrere Grad. Geglättet wird auf dem
// EINHEITSKREIS (Sinus/Kosinus gemittelt), nicht auf der Zahl — sonst liefe
// der Mittelwert beim Überschreiten von 360° einmal quer über die Karte.
//
// KALIBRIERUNG: `ajna.map.north_offset` ist derselbe Regler, den die große
// Karte schon benutzt. Der AR-Offset ist bewusst ein anderer — die AR-Kamera
// hört auf RELATIVE Ereignisse mit sitzungsabhängigem Nullpunkt, die beiden
// Kalibrierungen sind nicht übertragbar.

import { compassHeadingDeg } from './compassHeading.js'

const OFFSET_KEY = 'ajna.map.north_offset'
/** Gewicht des neuen Werts. Klein genug für Ruhe, groß genug fürs Mitgehen. */
const GLATT = 0.25
/** Älter als das, gilt der Kurs als abgestanden (ms). */
const FRISCH_MS = 4000

const zustand = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis)
  if (!g.__ajnaKompass) {
    g.__ajnaKompass = { deg: null, t: 0, sin: 0, cos: 0, laeuft: false, offset: 0, hoerer: new Set() }
    try { g.__ajnaKompass.offset = parseFloat(localStorage.getItem(OFFSET_KEY)) || 0 } catch {}
  }
  return g.__ajnaKompass
})()

function aufnehmen(ev) {
  const roh = compassHeadingDeg(ev)
  if (roh == null || !Number.isFinite(roh)) return
  const deg = ((roh + zustand.offset) % 360 + 360) % 360
  const r = deg * Math.PI / 180
  if (zustand.deg == null) {
    zustand.sin = Math.sin(r); zustand.cos = Math.cos(r)
  } else {
    zustand.sin += (Math.sin(r) - zustand.sin) * GLATT
    zustand.cos += (Math.cos(r) - zustand.cos) * GLATT
  }
  zustand.deg = ((Math.atan2(zustand.sin, zustand.cos) * 180 / Math.PI) % 360 + 360) % 360
  zustand.t = Date.now()
  // Für alle, die den Kurs nicht abfragen, sondern auf ihn warten.
  try { window.ajnaHeadingRad = zustand.deg * Math.PI / 180 } catch {}
  for (const h of zustand.hoerer) { try { h(zustand.deg) } catch {} }
}

/**
 * Sensor abonnieren. Mehrfach aufzurufen ist harmlos — es hört genau einer.
 *
 * iOS verlangt für den Kompass eine Nutzergeste. Der Aufruf hier ist ein
 * Versuch ins Blaue; schlägt er fehl, holt ihn `beiGesteFreischalten()` beim
 * nächsten Tippen nach. Ohne das bliebe der Kompass auf iPhones dauerhaft
 * stumm, ohne dass irgendwo ein Fehler auftaucht.
 */
export function starteKompass() {
  if (zustand.laeuft) return
  zustand.laeuft = true
  try { window.DeviceOrientationEvent?.requestPermission?.().catch(() => {}) } catch {}
  window.addEventListener('deviceorientationabsolute', aufnehmen, true)
  window.addEventListener('deviceorientation', aufnehmen, true)
  beiGesteFreischalten()
}

/**
 * Die Erlaubnis bei der nächsten Berührung nachholen (iOS). Einmal, dann weg —
 * ein Zuhörer, der bei jedem Tippen nachfragt, wäre zudringlich.
 */
export function beiGesteFreischalten() {
  const D = window.DeviceOrientationEvent
  if (!D || typeof D.requestPermission !== 'function') return
  const einmal = () => {
    ab()
    try { D.requestPermission().catch(() => {}) } catch {}
  }
  const ab = () => {
    window.removeEventListener('pointerdown', einmal, true)
    window.removeEventListener('touchend', einmal, true)
  }
  window.addEventListener('pointerdown', einmal, true)
  window.addEventListener('touchend', einmal, true)
}

/**
 * Aktueller Kurs in Grad (0 = Nord, im Uhrzeigersinn) — oder `null`.
 *
 * `null` heißt: kein Sensor, keine Erlaubnis, oder der letzte Wert ist zu alt.
 * Wer das mit „Norden" verwechselt, dreht die Karte bei jedem Aussetzer nach
 * oben. Der Aufrufer muss den Fall behandeln.
 */
export function kompassKurs() {
  if (zustand.deg == null) return null
  if (Date.now() - zustand.t > FRISCH_MS) return null
  return zustand.deg
}

/** Gibt es überhaupt je einen Wert gegeben? Für Hinweise in der Oberfläche. */
export const kompassVorhanden = () => zustand.deg != null

/** Auf Änderungen hören. Gibt die Abmeldung zurück. */
export function beiKompass(fn) {
  zustand.hoerer.add(fn)
  return () => zustand.hoerer.delete(fn)
}

/** Nordkorrektur setzen (dieselbe wie auf der großen Karte). */
export function setzeNordOffset(grad) {
  const g = Number(grad) || 0
  zustand.offset = g
  try { localStorage.setItem(OFFSET_KEY, String(g)) } catch {}
}
