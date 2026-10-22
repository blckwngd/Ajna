// Tests für agents/lib/ort.mjs — Stadt und Bundesland aus Nominatim, ohne Netz.
//
// Geprüft wird, was falsch sein kann: die Übersetzung der Antwort, der Punkt
// im Polygon (der ganze Grund für den Anbieter), und dass eine Gegend EINE
// Anfrage kostet — nicht eine je Gespräch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ortVars, punktInGeometrie, ortAnbieter, NAEHE_OHNE_UMRISS_M } from './ort.mjs'
import { Weltkontext } from './weltkontext.mjs'

// Koblenz, wie Nominatim es am 22.10.2026 lieferte (zoom=10, gekürzt).
const KOBLENZ = {
  osm_type: 'relation', osm_id: 62512, name: 'Koblenz',
  display_name: 'Koblenz, Rheinland-Pfalz, Deutschland',
  address: { city: 'Koblenz', state: 'Rheinland-Pfalz', 'ISO3166-2-lvl4': 'DE-RP', country: 'Deutschland', country_code: 'de' },
  boundingbox: ['50.2830010', '50.4096941', '7.4782507', '7.6964354'],
  // ein grobes Viereck um die Stadt — die Form zählt, nicht die Treue
  geojson: { type: 'Polygon', coordinates: [[[7.48, 50.28], [7.70, 50.28], [7.70, 50.41], [7.48, 50.41], [7.48, 50.28]]] },
}
const DORF = {
  osm_type: 'relation', osm_id: 1, name: 'Vallendar',
  address: { town: 'Vallendar', county: 'Landkreis Mayen-Koblenz', state: 'Rheinland-Pfalz', country: 'Deutschland', country_code: 'de' },
  geojson: { type: 'Polygon', coordinates: [[[7.60, 50.39], [7.66, 50.39], [7.66, 50.44], [7.60, 50.44], [7.60, 50.39]]] },
}

test('ortVars: Stadt, Kreis, Land, Staat und ein sprechfertiger Text', () => {
  const v = ortVars(KOBLENZ)
  assert.equal(v.stadt, 'Koblenz')
  assert.equal(v.land, 'Rheinland-Pfalz')
  assert.equal(v.staat, 'Deutschland')
  assert.equal(v.staat_code, 'de')
  assert.equal(v.text, 'Koblenz, Rheinland-Pfalz')
  const d = ortVars(DORF)
  assert.equal(d.stadt, 'Vallendar', 'town zählt wie city')
  assert.equal(d.kreis, 'Landkreis Mayen-Koblenz')
  assert.equal(ortVars({ address: {} }).text, '')
  assert.equal(ortVars({ name: 'Irgendwo', address: { country: 'Deutschland' } }).stadt, 'Irgendwo', 'notfalls der Name des Treffers')
})

test('Punkt im Polygon: innen, außen, im Loch, im zweiten Teil', () => {
  const quadrat = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }
  assert.equal(punktInGeometrie(quadrat, 5, 5), true)
  assert.equal(punktInGeometrie(quadrat, 15, 5), false)
  const mitLoch = { type: 'Polygon', coordinates: [quadrat.coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }
  assert.equal(punktInGeometrie(mitLoch, 5, 5), false, 'im Loch ist nicht drin')
  assert.equal(punktInGeometrie(mitLoch, 2, 2), true)
  const multi = { type: 'MultiPolygon', coordinates: [quadrat.coordinates, [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]] }
  assert.equal(punktInGeometrie(multi, 25, 25), true)
  assert.equal(punktInGeometrie(multi, 15, 15), false)
  assert.equal(punktInGeometrie({ type: 'Point', coordinates: [1, 1] }, 1, 1), false)
  assert.equal(punktInGeometrie(null, 1, 1), false)
})

function doppel(antworten) {
  const aufrufe = []
  return {
    aufrufe,
    async abruf(url, opts) {
      aufrufe.push({ url, ua: opts?.headers?.['User-Agent'] })
      const a = antworten.shift()
      if (a instanceof Error) throw a
      return { ok: true, json: async () => a }
    },
  }
}

test('eine Gegend kostet EINE Anfrage: der zweite Punkt im Umriss fragt nicht mehr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ort-'))
  try {
    const d = doppel([KOBLENZ, DORF])
    const a = ortAnbieter({ abruf: d.abruf, dir, kontakt: 'test@example.invalid', warn: () => {} })
    assert.equal(await a.vorbereiten({ lat: 50.3569, lon: 7.5890 }), true)
    assert.equal(d.aufrufe.length, 1)
    assert.match(d.aufrufe[0].url, /\/reverse\?format=jsonv2&lat=50\.35690&lon=7\.58900&zoom=10/)
    assert.match(d.aufrufe[0].url, /polygon_geojson=1/)
    assert.match(d.aufrufe[0].ua, /^Ajna\/1\.0 \(\+https:\/\/github\.com\/blckwngd\/Ajna; test@example\.invalid\)$/)
    // ein anderer Punkt in Koblenz: bekannt, keine Anfrage
    assert.equal(a.kennt(50.37, 7.60), true)
    assert.equal(await a.vorbereiten({ lat: 50.37, lon: 7.60 }), false)
    assert.equal(d.aufrufe.length, 1)
    assert.deepEqual(a.lies(50.37, 7.60).text, 'Koblenz, Rheinland-Pfalz')
    // außerhalb des Umrisses: unbekannt → Anfrage (der Mindestabstand von
    // 1,1 s gilt — darum kurz warten, wie es der Takt im Betrieb auch tut)
    assert.equal(a.kennt(50.42, 7.62), false)
    assert.equal(a.lies(50.42, 7.62), null, 'kein Raten über die Grenze')
    await new Promise(r => setTimeout(r, 1150))
    assert.equal(await a.vorbereiten({ lat: 50.42, lon: 7.62 }), true)
    assert.equal(d.aufrufe.length, 2)
    assert.equal(a.lies(50.42, 7.62).stadt, 'Vallendar')
    assert.equal(a.lies(50.37, 7.60).stadt, 'Koblenz', 'die Grenze trennt sauber')
    assert.equal(a.bestand, 2)

    // Ein zweiter Prozess liest die Ablage und kennt beide, ohne Netz.
    const b = ortAnbieter({ abruf: async () => { throw new Error('kein Netz') }, dir, warn: () => {} })
    assert.equal(await b.vorbereiten({ lat: 50.30, lon: 7.55 }), false)
    assert.equal(b.lies(50.30, 7.55).stadt, 'Koblenz')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('zu früh oder über Budget: keine Anfrage, kein Fehler — die Figur weiß es eben nicht', async () => {
  const d = doppel([KOBLENZ, KOBLENZ])
  const a = ortAnbieter({ abruf: d.abruf, dir: false, warn: () => {} })
  assert.equal(await a.vorbereiten({ lat: 50.3569, lon: 7.5890 }), true)
  // sofort danach ein fremder Punkt: der Mindestabstand (1,1 s) greift
  assert.equal(await a.vorbereiten({ lat: 51.5, lon: 10.5 }), false)
  assert.equal(d.aufrufe.length, 1)
  assert.equal(a.lies(51.5, 10.5), null)
})

test('ohne Umriss gilt ein Treffer nur in der Nähe des Abfragepunkts', async () => {
  const ohne = { ...KOBLENZ, geojson: undefined }
  const d = doppel([ohne])
  const a = ortAnbieter({ abruf: d.abruf, dir: false, warn: () => {} })
  await a.vorbereiten({ lat: 50.3569, lon: 7.5890 })
  assert.equal(a.kennt(50.3600, 7.5900), true, 'ein paar hundert Meter: ja')
  assert.equal(a.kennt(50.3569 + (NAEHE_OHNE_UMRISS_M * 2) / 111_000, 7.5890), false, 'drei Kilometer: nein')
})

test('im Weltkontext: punktgenau geholt und für den genauen Punkt gelesen', async () => {
  const d = doppel([KOBLENZ])
  const a = ortAnbieter({ abruf: d.abruf, dir: false, warn: () => {} })
  const k = new Weltkontext({ anbieter: [a], cache: false, warn: () => {} })
  const n = await k.frischen([], [{ lat: 50.3569, lon: 7.5890 }])
  assert.equal(n, 1)
  assert.equal(k.varsFuer(50.37, 7.60).ort.stadt, 'Koblenz')
  assert.equal(k.varsFuer(50.45, 7.62).ort, undefined, 'jenseits der Grenze: nichts, nicht Koblenz')
  assert.equal(d.aufrufe.length, 1)
})
