// Tests für agents/lib/weltkontext.mjs und wetter.mjs.
//
// Kein Netz: Der Wetter-Anbieter bekommt ein `abruf`-Doppel. Geprüft wird die
// Übersetzung (der Teil, der falsch sein kann) und das Verhalten des Vorrats —
// vor allem, dass Abgelaufenes als NICHT VORHANDEN gilt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Weltkontext, zelleFuer, zellenMitte, ZELLE_GRAD } from './weltkontext.mjs'
import { wetterVars, wetterAnbieter, windText, WMO_TEXT } from './wetter.mjs'
import { himmelVars } from './himmel.mjs'

// ─── Zellen ───────────────────────────────────────────────────────────────

test('nahe Punkte fallen in dieselbe Zelle', () => {
  // Der ganze Sinn: EINE Abfrage je Gegend, nicht je Gespräch.
  const a = zelleFuer(50.4297, 7.4608)
  const b = zelleFuer(50.4390, 7.4712)
  assert.equal(a, b, `${a} vs ${b}`)
})

test('an einer Zellengrenze aber nicht — und das ist hingenommen', () => {
  // Jedes Raster hat diese Kante: Zwei Punkte, zwei Kilometer auseinander,
  // können auf verschiedenen Seiten liegen. Die Folge ist eine zweite Abfrage
  // für praktisch dasselbe Wetter — harmlos. Die Alternative wäre ein
  // Nachbarschafts-Suchlauf, der viel mehr kostet, als er spart.
  assert.notEqual(zelleFuer(50.4297, 7.46), zelleFuer(50.4501, 7.46))
})

test('ferne Punkte nicht', () => {
  assert.notEqual(zelleFuer(50.43, 7.46), zelleFuer(50.63, 7.46))
})

test('die Zelle ist lesbar und findet zu ihrem Mittelpunkt zurück', () => {
  const z = zelleFuer(50.4297, 7.4608)
  assert.match(z, /^z-?\d+\.\d+,-?\d+\.\d+$/)
  const m = zellenMitte(z)
  assert.ok(Math.abs(m.lat - 50.4297) <= ZELLE_GRAD)
  assert.ok(Math.abs(m.lon - 7.4608) <= ZELLE_GRAD)
})

test('Unsinn ergibt keinen Mittelpunkt', () => {
  assert.equal(zellenMitte('irgendwas'), null)
  assert.equal(zellenMitte(''), null)
})

// ─── Der Vorrat ───────────────────────────────────────────────────────────

/** Ein Anbieter, der zählt, wie oft er gefragt wurde. */
function zaehlAnbieter(ttlMs = 1000, werte = { text: 'klarer Himmel' }) {
  let abrufe = 0
  return {
    name: 'wetter', ttlMs,
    get abrufe() { return abrufe },
    async hole() { abrufe++; return { ...werte } },
  }
}

function bau(anbieter, jetztRef) {
  return new Weltkontext({
    anbieter: [anbieter], cache: false, warn: () => {}, jetzt: () => jetztRef.t,
  })
}

test('geholt wird einmal je Zelle, nicht je Abfrage', () => {
  return (async () => {
    const uhr = { t: 1000 }
    const a = zaehlAnbieter()
    const k = bau(a, uhr)
    await k.frischen(['z50.40,7.50'])
    await k.frischen(['z50.40,7.50'])
    await k.frischen(['z50.40,7.50'])
    assert.equal(a.abrufe, 1)
  })()
})

test('der Zugriff im Gespräch ist synchron und trägt den Namensraum', () => {
  return (async () => {
    const uhr = { t: 1000 }
    const k = bau(zaehlAnbieter(), uhr)
    await k.frischen([zelleFuer(50.43, 7.46)])
    const vars = k.varsFuer(50.43, 7.46)          // KEIN await
    assert.equal(vars.wetter.text, 'klarer Himmel')
  })()
})

test('abgelaufen gilt als nicht vorhanden', () => {
  return (async () => {
    // Ein Wetter von vor sechs Stunden ist schlechter als keines — die Figur
    // behauptet sonst etwas, das der Spieler selbst widerlegen kann.
    const uhr = { t: 1000 }
    const k = bau(zaehlAnbieter(1000), uhr)
    await k.frischen(['z50.40,7.50'])
    assert.ok(k.varsFuer(50.40, 7.50).wetter, 'frisch da')
    uhr.t += 5000
    assert.equal(k.varsFuer(50.40, 7.50).wetter, undefined, 'abgelaufen weg')
    assert.equal(k.bestand, 0)
  })()
})

test('nach Ablauf wird neu geholt', () => {
  return (async () => {
    const uhr = { t: 1000 }
    const a = zaehlAnbieter(1000)
    const k = bau(a, uhr)
    await k.frischen(['z50.40,7.50'])
    uhr.t += 5000
    await k.frischen(['z50.40,7.50'])
    assert.equal(a.abrufe, 2)
  })()
})

test('ein stummer Anbieter bringt keine Figur zum Schweigen', () => {
  return (async () => {
    // Fehler werden gewarnt, nicht geworfen. Ein Wetterdienst, der ausfällt,
    // darf den Dialogpfad nicht mitreissen.
    const uhr = { t: 1000 }
    let gewarnt = ''
    const k = new Weltkontext({
      anbieter: [{ name: 'wetter', ttlMs: 1000, hole: async () => { throw new Error('kaputt') } }],
      cache: false, jetzt: () => uhr.t, warn: (m) => { gewarnt = m },
    })
    await k.frischen(['z50.40,7.50'])          // wirft nicht
    assert.match(gewarnt, /kaputt/)
    assert.deepEqual(k.varsFuer(50.40, 7.50), {})
  })()
})

test('zwei gleichzeitige Durchläufe ergeben eine Abfrage', () => {
  return (async () => {
    const uhr = { t: 1000 }
    let abrufe = 0
    const k = new Weltkontext({
      anbieter: [{
        name: 'wetter', ttlMs: 10_000,
        hole: () => { abrufe++; return new Promise(r => setTimeout(() => r({ text: 'x' }), 20)) },
      }],
      cache: false, warn: () => {}, jetzt: () => uhr.t,
    })
    await Promise.all([k.frischen(['z50.40,7.50']), k.frischen(['z50.40,7.50'])])
    assert.equal(abrufe, 1)
  })()
})

test('aufraeumen entfernt nur Abgelaufenes', () => {
  return (async () => {
    const uhr = { t: 1000 }
    const k = bau(zaehlAnbieter(1000), uhr)
    await k.frischen(['z50.40,7.50', 'z51.00,7.50'])
    assert.equal(k.bestand, 2)
    assert.equal(k.aufraeumen(), 0)
    uhr.t += 5000
    assert.equal(k.aufraeumen(), 2)
  })()
})

// ─── Wetter-Übersetzung ───────────────────────────────────────────────────

const ANTWORT = {
  current: { temperature_2m: 20.8, apparent_temperature: 18.7, weather_code: 61, wind_speed_10m: 5.8 },
  daily: { sunrise: ['2026-09-23T07:17'], sunset: ['2026-09-23T19:26'], uv_index_max: [4.1] },
}

test('aus einem WMO-Code wird ein Satzbaustein', () => {
  const v = wetterVars(ANTWORT)
  assert.equal(v.text, 'leichter Regen')
  assert.equal(v.grad, 21)
  assert.equal(v.gefuehlt, 19)
  assert.equal(v.regen, true)
  assert.equal(v.schnee, false)
  assert.equal(v.gewitter, false)
  assert.equal(v.uv, 4)
})

test('die Sonnenzeiten werden mitgespeichert, die Tageszeit NICHT', () => {
  // Sie gelten den ganzen Tag — Tageszeit und Mond dagegen ändern sich
  // schneller als der Takt und werden erst beim Sprechen gerechnet.
  const v = wetterVars(ANTWORT)
  assert.equal(v.sonne.sonnenuntergang, '2026-09-23T19:26')
  assert.equal(v.tageszeit, undefined)
  assert.equal(v.mond, undefined)
})

test('abgeleitete Werte entstehen beim Zugriff, nicht beim Holen', () => {
  return (async () => {
    // Der Test, der die Entscheidung festhält: Zwei Zugriffe zu verschiedenen
    // Zeiten liefern verschiedene Tageszeiten, OBWOHL nur einmal geholt wurde.
    const uhr = { t: 1000 }
    let abrufe = 0
    const anbieter = {
      name: 'wetter', ttlMs: 10 * 60_000,
      async hole() { abrufe++; return { text: 'klarer Himmel', sonne: {
        sonnenaufgang: '2026-09-23T07:17', sonnenuntergang: '2026-09-23T19:26' } } },
      abgeleitet: (w) => ({ himmel: himmelVars(zeitpunkt, w.sonne) }),
    }
    let zeitpunkt = new Date(2026, 8, 23, 14, 0)
    const k = new Weltkontext({ anbieter: [anbieter], cache: false, warn: () => {}, jetzt: () => uhr.t })
    await k.frischen(['z50.40,7.50'])
    assert.equal(k.varsFuer(50.40, 7.50).himmel.tageszeit, 'Nachmittag')
    zeitpunkt = new Date(2026, 8, 23, 21, 0)
    assert.equal(k.varsFuer(50.40, 7.50).himmel.tageszeit, 'Nacht')
    assert.equal(abrufe, 1, 'kein zweiter Abruf für eine Uhrzeit')
  })()
})

test('der Wetter-Anbieter leitet den Himmel selbst ab', () => {
  const a = wetterAnbieter()
  const abgeleitet = a.abgeleitet(wetterVars(ANTWORT))
  assert.equal(typeof abgeleitet.himmel.mond, 'string')
  assert.equal(abgeleitet.himmel.sonnenuntergang, '19:26')
})

test('Gewitter und Schnee sind eigene Merker', () => {
  const g = wetterVars({ current: { weather_code: 95 }, daily: {} })
  assert.equal(g.gewitter, true)
  assert.equal(g.regen, true, 'ein Gewitter ist auch nass')
  const s = wetterVars({ current: { weather_code: 73 }, daily: {} })
  assert.equal(s.schnee, true)
  assert.equal(s.regen, false)
})

test('eine unbekannte Antwort wird nicht erfunden', () => {
  const v = wetterVars({})
  assert.equal(v.text, 'unbestimmtes Wetter')
  assert.equal(v.grad, null)
  assert.equal(v.uv, null)
})

test('jeder Code hat einen deutschen Text, keiner eine Zahl', () => {
  for (const [code, text] of Object.entries(WMO_TEXT)) {
    assert.equal(typeof text, 'string', code)
    assert.ok(text.length > 3 && !/^\d+$/.test(text), `${code}: "${text}"`)
  }
})

test('Wind wird in Worten gesagt', () => {
  assert.equal(windText(0), 'windstill')
  assert.equal(windText(5.8), 'leichter Wind')
  assert.equal(windText(35), 'starker Wind')
  assert.equal(windText(90), 'Orkan')
  assert.equal(windText('Unfug'), '')
})

test('der Anbieter baut die Abfrage und reicht Fehler durch', () => {
  return (async () => {
    let gesehen = ''
    const a = wetterAnbieter({
      abruf: async (url) => { gesehen = url; return { ok: true, json: async () => ANTWORT } },
    })
    const v = await a.hole({ lat: 50.4297, lon: 7.4608 })
    assert.match(gesehen, /latitude=50\.4297/)
    assert.match(gesehen, /timezone=auto/)
    assert.equal(v.text, 'leichter Regen')

    const kaputt = wetterAnbieter({ abruf: async () => ({ ok: false, status: 503 }) })
    await assert.rejects(() => kaputt.hole({ lat: 1, lon: 1 }), /503/)
  })()
})
