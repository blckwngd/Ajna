#!/usr/bin/env node
//
// tests/run-landing.mjs — Landeplatz-Geometrie (agents/lib/landing-spots.mjs).
//
//   npm run test:landing        (kein Stack nötig — reine Rechnung)
//
// Warum eigenständig: der Landeplatz entscheidet, ob ein Drache im Vorgarten
// oder im Wohnzimmer aufsetzt. Das will man prüfen können, ohne den
// World-Director, einen Spieler und eine Overpass-Antwort zu brauchen.

import {
  findLandingSpot, pointInPolygon, roofHeight, centroid, distM,
  DEFAULT_MIN_M, DEFAULT_MAX_M
} from '../agents/lib/landing-spots.mjs'

const results = []
const check = (name, cond) => {
  results.push({ name, ok: !!cond })
  console.log(`   ${cond ? '✅' : '❌'} ${name}`)
}

const P = { lat: 50.4466, lon: 7.5971 }
// Quadrat um einen Mittelpunkt bauen (Kantenlänge 2*halfM).
function squareAround(lat, lon, halfM) {
  const dLat = halfM / 111320
  const dLon = halfM / (111320 * Math.cos(lat * Math.PI / 180))
  return [
    [lat - dLat, lon - dLon], [lat - dLat, lon + dLon],
    [lat + dLat, lon + dLon], [lat + dLat, lon - dLon],
  ]
}

console.log('\n── Punkt-in-Polygon')
const sq = squareAround(P.lat, P.lon, 20)
check('Mittelpunkt liegt im Quadrat', pointInPolygon(P.lat, P.lon, sq))
check('Punkt weit außerhalb liegt draußen', !pointInPolygon(P.lat + 0.01, P.lon, sq))
check('entartetes Polygon (2 Punkte) → false', !pointInPolygon(P.lat, P.lon, [[0, 0], [1, 1]]))
check('leeres/undefiniertes Polygon → false', !pointInPolygon(P.lat, P.lon, undefined))

console.log('\n── Gebäudehöhe aus OSM-Tags (gemeinsam mit dem 3D-Wireframe)')
check('height gewinnt vor Geschossen', roofHeight({ height: '12.5', 'building:levels': '2' }) === 12.5)
check('"12 m" wird gelesen', roofHeight({ height: '12 m' }) === 12)
check('building:height als Alternative', roofHeight({ 'building:height': '9' }) === 9)
check('est_height als Alternative', roofHeight({ est_height: '11' }) === 11)
check('Geschosse × 3,2 m', Math.abs(roofHeight({ 'building:levels': '4' }) - 12.8) < 1e-9)
check('+ Dachgeschoss zählt weniger', Math.abs(roofHeight({ 'building:levels': '2', 'roof:levels': '1' }) - (2 * 3.2 + 2.5)) < 1e-9)
check('Unsinn im Tag → fällt zurück', roofHeight({ height: 'ja' }) === 8)

// DER Punkt für die Sichtbarkeit: die meisten OSM-Gebäude haben GAR KEINE
// Höhenangabe. Ohne Typ-Schätzung wären sie alle exakt gleich hoch.
console.log('\n── Schätzung aus der Gebäudeart (wenn keine Höhe getaggt ist)')
check('Kirche überragt deutlich', roofHeight({ building: 'church' }) > 15)
check('Garage ist niedrig', roofHeight({ building: 'garage' }) <= 3)
check('Wohnhaus im mittleren Bereich', roofHeight({ building: 'house' }) === 7)
check('Mehrfamilienhaus höher als Wohnhaus',
  roofHeight({ building: 'apartments' }) > roofHeight({ building: 'house' }))
check('Bürogebäude höher als Einzelhandel',
  roofHeight({ building: 'office' }) > roofHeight({ building: 'retail' }))
check('unbekannte Art → Default 8 m', roofHeight({ building: 'gibtsnicht' }) === 8)
check('Groß-/Kleinschreibung egal', roofHeight({ building: 'CHURCH' }) === roofHeight({ building: 'church' }))
check('ohne Tags → Default 8 m', roofHeight({}) === 8)

// Und die Kernaussage in einem Satz: die Silhouette differenziert sich.
const variety = new Set(['church', 'garage', 'house', 'apartments', 'office', 'industrial', 'shed']
  .map(b => roofHeight({ building: b })))
check(`7 Gebäudearten → ${variety.size} verschiedene Höhen`, variety.size >= 6)

console.log('\n── Landeplatz: freies Feld')
const free = findLandingSpot({ ...P, buildings: [], rng: () => 0 })
check('findet einen Bodenplatz', free?.kind === 'ground')
const dFree = distM(P.lat, P.lon, free.lat, free.lon)
check(`Abstand im Ring ${DEFAULT_MIN_M}–${DEFAULT_MAX_M} m (${dFree.toFixed(1)} m)`,
  dFree >= DEFAULT_MIN_M - 0.5 && dFree <= DEFAULT_MAX_M + 0.5)
check('landet nicht auf dem Spieler', dFree >= DEFAULT_MIN_M - 0.5)
check('Bodenhöhe = 0', free.altitude === 0)

console.log('\n── Landeplatz: Gebäude wird gemieden')
// Ein Haus, das die halbe Umgebung bedeckt (Mitte 12 m nördlich, 10 m Halbkante).
const houseCenter = { lat: P.lat + 12 / 111320, lon: P.lon }
const house = { coordinates: squareAround(houseCenter.lat, houseCenter.lon, 10), tags: { 'building:levels': '3' } }
const nextToHouse = findLandingSpot({ ...P, buildings: [house], rng: () => 0 })
check('findet trotzdem einen Bodenplatz', nextToHouse?.kind === 'ground')
check('Bodenplatz liegt NICHT im Haus', !pointInPolygon(nextToHouse.lat, nextToHouse.lon, house.coordinates))

console.log('\n── Kür: Dach, wenn ringsum alles verbaut ist')
// Riesiges Gebäude, das den kompletten Suchring verschluckt.
const mega = { coordinates: squareAround(P.lat, P.lon, 60), tags: { 'building:levels': '5' } }
const roof = findLandingSpot({ ...P, buildings: [mega], rng: () => 0 })
check('weicht aufs Dach aus', roof?.kind === 'roof')
check('Dachhöhe = 5 Geschosse × 3,2 m = 16 m', Math.abs(roof?.altitude - 16) < 1e-9)
check('Dachpunkt liegt im Gebäude', pointInPolygon(roof.lat, roof.lon, mega.coordinates))

console.log('\n── Robustheit')
check('ungültige Position → null', findLandingSpot({ lat: NaN, lon: 7 }) === null)
check('kaputte Gebäude-Features werden ignoriert',
  findLandingSpot({ ...P, buildings: [{ coordinates: null }, { foo: 1 }], rng: () => 0 })?.kind === 'ground')
check('Schwerpunkt eines Quadrats ist dessen Mitte',
  Math.abs(centroid(sq).lat - P.lat) < 1e-9 && Math.abs(centroid(sq).lon - P.lon) < 1e-9)

// Richtungs-Abwechslung: zwei Rufe mit verschiedenem rng → verschiedene Plätze.
const a = findLandingSpot({ ...P, rng: () => 0.0 })
const b = findLandingSpot({ ...P, rng: () => 0.5 })
check('verschiedene Rufe → verschiedene Richtungen', distM(a.lat, a.lon, b.lat, b.lon) > 1)

const failed = results.filter(r => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
console.log(`Landeplatz: ${results.length - failed.length} bestanden, ${failed.length} fehlgeschlagen`)
if (failed.length) {
  console.log('\nFehlgeschlagen:')
  for (const f of failed) console.log('  ❌ ' + f.name)
  process.exit(1)
}
console.log('✅ alles grün')
