// Tests für agents/lib/hauskoordinaten.mjs — die Teile, die ohne den
// 196-MB-Abzug prüfbar sind: die Koordinatenumrechnung und das Lesen einer
// Zeile. Die Datenbankfunktionen brauchen die Datei und laufen deshalb hier
// nicht mit; was sie können, zeigt der Agent im Betrieb.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utmZuWgs, zeileZuAdresse, zelle, HERKUNFT } from './hauskoordinaten.mjs'

// Eine echte Zeile aus dem Abzug — Harbach, Hauptstraße 58. Sie ist der
// Prüfstein der Umrechnung: ihre Lage ist gegen die Karte bestätigt.
const ZEILE = 'N;DERPLP0100000JBA;A;07;Rheinland-Pfalz;1;Koblenz;32;Altenkirchen (Ww);' +
              '045;Harbach;0000;;00204;Hauptstraße;58;;32;418052.876;5635487.903'

test('utmZuWgs trifft einen bekannten Punkt', () => {
  // Harbach, Hauptstraße 58 — gegen die Karte geprüft.
  const { lat, lon } = utmZuWgs(418052.876, 5635487.903, 32)
  assert.ok(Math.abs(lat - 50.865264) < 1e-5, `lat ${lat}`)
  assert.ok(Math.abs(lon - 7.835509) < 1e-5, `lon ${lon}`)
})

test('utmZuWgs bleibt auf dem Mittelmeridian der Zone', () => {
  // Ostwert 500000 ist per Definition der Mittelmeridian; Zone 32 → 9° Ost.
  const { lon } = utmZuWgs(500000, 5600000, 32)
  assert.ok(Math.abs(lon - 9) < 1e-9, `lon ${lon}`)
})

test('utmZuWgs ist umkehrbar — ein Meter Ost bleibt ein Meter Ost', () => {
  const a = utmZuWgs(418052.876, 5635487.903, 32)
  const b = utmZuWgs(418152.876, 5635487.903, 32)   // 100 m östlich
  const meterProGrad = 111320 * Math.cos(a.lat * Math.PI / 180)
  assert.ok(Math.abs((b.lon - a.lon) * meterProGrad - 100) < 1, 'Ost-Abstand')
  assert.ok(Math.abs(b.lat - a.lat) < 1e-4, 'kaum Nord-Versatz')
})

test('zeileZuAdresse liest Straße, Hausnummer und Ort', () => {
  const a = zeileZuAdresse(ZEILE)
  assert.equal(a.strasse, 'Hauptstraße')
  assert.equal(a.hausnummer, '58')
  assert.equal(a.ort, 'Harbach')          // Ortsteil leer → Gemeinde
  assert.ok(Math.abs(a.lat - 50.865264) < 1e-5)
})

test('zeileZuAdresse hängt den Adresszusatz an die Hausnummer', () => {
  const f = ZEILE.split(';')
  f[16] = 'a'
  assert.equal(zeileZuAdresse(f.join(';')).hausnummer, '58a')
})

test('zeileZuAdresse nimmt den Ortsteil, wenn er gefüllt ist', () => {
  const f = ZEILE.split(';')
  f[12] = 'Niederhausen'
  assert.equal(zeileZuAdresse(f.join(';')).ort, 'Niederhausen')
})

test('zeileZuAdresse verwirft Zeilen ohne Hausnummer', () => {
  // Eine Adresse ohne Hausnummer ist genau das, was OSM schon hat — sie
  // brächte nichts und stünde nur als Dublette im Ergebnis.
  const f = ZEILE.split(';')
  f[15] = ''
  assert.equal(zeileZuAdresse(f.join(';')), null)
})

test('zeileZuAdresse verwirft Schrott statt zu raten', () => {
  assert.equal(zeileZuAdresse(''), null)
  assert.equal(zeileZuAdresse(null), null)
  assert.equal(zeileZuAdresse('zu;wenig;spalten'), null)
  const f = ZEILE.split(';')
  f[18] = 'keine Zahl'
  assert.equal(zeileZuAdresse(f.join(';')), null)
})

test('zelle rastert gleich für benachbarte Punkte', () => {
  // Zwei Punkte innerhalb von ~100 m dürfen sich höchstens eine Zelle
  // unterscheiden — sonst greift die Nachbarschaftssuche daneben.
  assert.ok(Math.abs(zelle(50.4513) - zelle(50.4522)) <= 1)
  assert.equal(zelle(50.451337), 5045)
})

test('die Herkunft nennt Lizenz und Stelle', () => {
  // Namensnennung ist Lizenzpflicht (dl-de/by-2-0), nicht Höflichkeit.
  assert.match(HERKUNFT, /LVermGeoRP/)
  assert.match(HERKUNFT, /dl-de\/by-2-0/)
})
