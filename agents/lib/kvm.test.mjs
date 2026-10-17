// Tests für agents/lib/kvm.mjs.
//
// HERKUNFT DER TESTDATEN: Am 17.10.2026 von api.ofdb.io geholt und gekürzt —
// echte Einträge aus Koblenz, samt der Kategorie-Kennungen aus /v0/categories.
// Erfundene hätten genau die Felder, die man erwartet, und keines der Löcher.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asSighting, usable, kindOf, ratingsOf, bbox, distanceKm, CATEGORIES, RATING_AXES,
} from './kvm.mjs'

// [ECHT] /v0/entries/af1c17b5029c42b48be293afa14129cf
const ISSOLAB = {
  id: 'af1c17b5029c42b48be293afa14129cf', created: 1525697556, version: 0,
  title: 'ISSOlab',
  description: 'Das ISSOlab versteht sich als Praxislabor in dem Ideen und Konzepte erprobt werden, '
    + 'um Lösungen für eine Transformation in eine nachhaltige Gesellschaft zu finden.',
  lat: 50.36214328853513, lng: 7.598247615433413,
  street: 'Kornpfortstr. 15', zip: '56068', city: 'Koblenz',
  country: null, state: null, contact_name: null, email: null,
  telephone: '0261 – 204 391 0', homepage: 'http://isso.de/issolab/',
  opening_hours: null, founded_on: null,
  categories: ['77b3c33a92554bcf8e8c2c86cedd6f6f'],
  tags: ['gründerökosystem', 'socent', 'social-startup'],
  ratings: ['f7f30666ce454e7ba4c58c39f5325908'],
  license: 'CC0-1.0', image_url: null, image_link_url: null,
}

// [ECHT] Form aus /v0/search — dort sind `ratings` ein Objekt, kein Array.
const AUS_SUCHE = {
  id: 'af1c17b5029c42b48be293afa14129cf', status: 'created',
  lat: 50.36214328853513, lng: 7.598247615433413,
  title: 'ISSOlab', description: 'Praxislabor für Nachhaltigkeit.',
  categories: ['77b3c33a92554bcf8e8c2c86cedd6f6f'],
  tags: ['gründerökosystem', 'socent', 'social-startup'],
  ratings: { total: 0.333, diversity: 0, fairness: 0, humanity: 0,
             renewable: 0, solidarity: 2.0, transparency: 0 },
}

const initiative = (ue = {}) => ({ ...AUS_SUCHE, categories: ['2cd00bebec0c48ba9db761da48678134'], ...ue })
const veranstaltung = (ue = {}) => ({ ...AUS_SUCHE, categories: ['c2dc278a2d6a4b9b8a50cb606fc017ed'], ...ue })

// ─── Kategorien ───────────────────────────────────────────────────────────

test('[ECHT] die drei Kategorien sind die der API', () => {
  // Gegen /v0/categories geprüft: #non-profit, #commercial, #event.
  assert.equal(Object.keys(CATEGORIES).length, 3)
  assert.equal(kindOf(ISSOLAB).key, 'business')
  assert.equal(kindOf(initiative()).key, 'initiative')
  assert.equal(kindOf(veranstaltung()).key, 'event')
})

test('eine unbekannte Kategorie wird nicht zur falschen', () => {
  const fremd = { ...AUS_SUCHE, categories: ['neue-kennung-von-morgen'] }
  assert.equal(kindOf(fremd).key, 'other')
  assert.equal(kindOf({}).key, 'other')
})

test('jede Kategorie und jede Achse hat eine Beschriftung', () => {
  for (const [id, k] of Object.entries(CATEGORIES)) {
    assert.ok(k.label.length > 3 && k.emoji && k.key, id)
  }
  for (const [k, v] of Object.entries(RATING_AXES)) assert.ok(v.length > 4, k)
})

// ─── Auswahl ──────────────────────────────────────────────────────────────

test('VERANSTALTUNGEN BLEIBEN DRAUSSEN, solange Objekte nicht verfallen', () => {
  // Ein Termin, der nicht von selbst verschwindet, ist in einem Monat Müll —
  // und in einem Jahr eine Lüge über etwas, das längst vorbei ist. Es fehlt
  // `state.expires_at` (docs/arbeitspakete.md, Paket 5a).
  assert.equal(usable(veranstaltung()), false)
  assert.equal(usable(veranstaltung(), { mitVeranstaltungen: true }), true)
})

test('ohne Titel oder Ort ist es kein Eintrag', () => {
  assert.equal(usable({ ...AUS_SUCHE, title: '' }), false)
  assert.equal(usable({ ...AUS_SUCHE, lat: null }), false)
  assert.equal(usable({ ...AUS_SUCHE, lat: 0, lng: 0 }), false, 'Null-Insel ist kein Ort')
  assert.equal(usable(null), false)
})

test('nach Art und Mindestbewertung lässt sich sieben', () => {
  assert.equal(usable(ISSOLAB, { arten: ['initiative'] }), false)
  assert.equal(usable(ISSOLAB, { arten: ['business'] }), true)
  assert.equal(usable(AUS_SUCHE, { minBewertung: 1 }), false, 'total 0,333 reicht nicht')
  assert.equal(usable(AUS_SUCHE, { minBewertung: 0.3 }), true)
})

test('ein Eintrag ohne Bewertung fällt nicht durch die Mindestgrenze', () => {
  // Die Detailform führt `ratings` als ARRAY von Kennungen — dort gibt es
  // keinen Gesamtwert. Ihn als 0 zu lesen würde jeden Detaileintrag verwerfen.
  assert.equal(usable(ISSOLAB, { minBewertung: 0 }), true)
})

// ─── Bewertungen ──────────────────────────────────────────────────────────

test('[ECHT] nur Achsen mit einem Wert werden genannt, die stärkste zuerst', () => {
  const b = ratingsOf(AUS_SUCHE.ratings)
  assert.equal(b.length, 1, 'sechs von sieben stehen auf 0')
  assert.equal(b[0].label, 'Solidarität')
  assert.equal(b[0].wert, 2)
})

test('ohne Bewertungen gibt es keine erfundenen', () => {
  assert.equal(ratingsOf(null), null)
  assert.equal(ratingsOf({}), null)
  assert.equal(ratingsOf({ total: 0, fairness: 0 }), null)
  assert.equal(ratingsOf(['nur', 'kennungen']), null, 'die Detailform ist ein Array')
})

// ─── Übersetzung ──────────────────────────────────────────────────────────

test('[ECHT] ein Eintrag wird zu etwas, das man vorlesen kann', () => {
  const s = asSighting(ISSOLAB)
  assert.equal(s.name, 'ISSOlab')
  assert.equal(s.appearance.emoji, '🤝')
  const erste = s.description.split('\n')[0]
  assert.ok(erste.length <= 100, `${erste.length}: ${erste}`)
  assert.match(erste, /^Unternehmen · gründerökosystem/)
})

test('[ECHT] Anschrift, Kontakt und Schlagworte stehen in der Langfassung', () => {
  const d = asSighting(ISSOLAB).description
  assert.match(d, /Anschrift: Kornpfortstr\. 15, 56068 Koblenz/)
  assert.match(d, /Kontakt:.*0261.*isso\.de/)
  assert.match(d, /Praxislabor/)
})

test('[ECHT] die Lizenz des EINTRAGS wandert mit', () => {
  // Sie steht je Eintrag, nicht am Projekt — CC0-1.0 oder ODbL-1.0, je nachdem,
  // was derjenige gewählt hat, der ihn angelegt hat.
  const s = asSighting(ISSOLAB)
  assert.match(s.description, /Karte von Morgen \(kartevonmorgen\.org\), CC0-1\.0/)
  assert.equal(s.state.license, 'CC0-1.0')
})

test('Bewertungen erscheinen als MEINUNG, nicht als Eigenschaft', () => {
  // „Solidarität 2,0" als Tatsache über einen Betrieb zu behaupten, tragen
  // diese Zahlen nicht — sie kommen von Besuchern der Karte.
  const d = asSighting(AUS_SUCHE).description
  assert.match(d, /Von Besuchern bewertet: Solidarität 2/)
})

test('ein Name bleibt in den 32 Zeichen, die objects.name fasst', () => {
  const lang = { ...ISSOLAB, title: 'Solidarische Landwirtschaft Mittelrhein und Umgebung e.V.' }
  assert.ok(asSighting(lang).name.length <= 32)
})

test('fehlende Felder erzeugen keine leeren Zeilen', () => {
  const karg = { id: 'x', title: 'Nur ein Name', lat: 50.3, lng: 7.5, categories: [], tags: [] }
  const d = asSighting(karg).description
  assert.ok(!d.includes('\n\n\n'), JSON.stringify(d))
  assert.ok(!/:\s*$/m.test(d), 'keine Zeile endet mit leerem Doppelpunkt')
  assert.match(d, /Karte von Morgen/)
})

// ─── Abfragefenster ───────────────────────────────────────────────────────

test('die BBOX hat die Form, die /v0/search erwartet', () => {
  // süd,west,nord,ost — in genau dieser Reihenfolge.
  const b = bbox(50.3591, 7.5932, 5).split(',').map(Number)
  assert.equal(b.length, 4)
  assert.ok(b[0] < 50.3591 && b[2] > 50.3591, 'Breiten umschliessen den Punkt')
  assert.ok(b[1] < 7.5932 && b[3] > 7.5932, 'Längen umschliessen den Punkt')
})

test('die BBOX deckt den gewünschten Radius wirklich ab', () => {
  // Ein zu kleines Rechteck verlöre still Treffer am Rand.
  const r = 5
  const [s, w, n, o] = bbox(50.3591, 7.5932, r).split(',').map(Number)
  assert.ok(distanceKm(50.3591, 7.5932, n, 7.5932) >= r, 'nach Norden zu knapp')
  assert.ok(distanceKm(50.3591, 7.5932, 50.3591, o) >= r, 'nach Osten zu knapp')
  assert.ok(s < n && w < o)
})

test('Entfernung stimmt gegen eine bekannte Strecke', () => {
  // Koblenz → Neuwied, Luftlinie rund 10 km.
  const km = distanceKm(50.3591, 7.5932, 50.4514, 7.5363)
  assert.ok(km > 9 && km < 12, `${km.toFixed(1)} km`)
})

test('[ECHT] Detail und Suchtreffer zusammengeführt ergeben das volle Bild', () => {
  // `/search` liefert die BEWERTUNGEN als Objekt, `/entries` nur deren
  // Kennungen — dafür Anschrift, Kontakt und Lizenz. Erst beides zusammen
  // ergibt einen Eintrag, der etwas taugt.
  const s = asSighting({ ...ISSOLAB, ratings: AUS_SUCHE.ratings })
  assert.match(s.description, /Anschrift: Kornpfortstr\. 15/)
  assert.match(s.description, /Von Besuchern bewertet: Solidarität 2/)
  assert.match(s.description, /CC0-1\.0/)
  assert.equal(s.state.rating_total, 0.33)
})
