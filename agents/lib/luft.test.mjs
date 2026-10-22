import { test } from 'node:test'
import assert from 'node:assert/strict'
import { luftVars, aqiText, luftAnbieter, POLLEN_SCHWELLE } from './luft.mjs'
import { Weltkontext, zelleFuer } from './weltkontext.mjs'

// Koblenz, 22.10.2026 14:00 — so kam es von Open-Meteo.
const ANTWORT = { current: {
  time: '2026-10-22T14:00', european_aqi: 21, pm10: 7.1, pm2_5: 3.7, ozone: 61.0, nitrogen_dioxide: 3.4,
  alder_pollen: 0, birch_pollen: 0, grass_pollen: 0, mugwort_pollen: 0, olive_pollen: 0, ragweed_pollen: 0,
} }

test('EAQI in Worten, an den Stufengrenzen', () => {
  assert.equal(aqiText(0), 'gut')
  assert.equal(aqiText(20), 'gut')
  assert.equal(aqiText(21), 'mäßig')
  assert.equal(aqiText(60), 'mittel')
  assert.equal(aqiText(61), 'schlecht')
  assert.equal(aqiText(100), 'sehr schlecht')
  assert.equal(aqiText(140), 'extrem schlecht')
  assert.equal(aqiText('nein'), '')
})

test('luftVars: sprechfertig, Pollen nur über der Schwelle', () => {
  const v = luftVars(ANTWORT)
  assert.equal(v.aqi, 21)
  assert.equal(v.text, 'mäßig')
  assert.equal(v.schlecht, false)
  assert.equal(v.pm10, 7)
  assert.equal(v.pm25, 4)
  assert.equal(v.pollen, false)
  assert.equal(v.pollen_text, '')
  const fruehling = luftVars({ current: { european_aqi: 70, birch_pollen: 120, grass_pollen: POLLEN_SCHWELLE, alder_pollen: 3 } })
  assert.equal(fruehling.schlecht, true)
  assert.equal(fruehling.pollen, true)
  assert.equal(fruehling.pollen_text, 'Birke, Gräser', 'stärkste zuerst, Erle unter der Schwelle fehlt')
  assert.equal(luftVars({}).aqi, null)
  assert.equal(luftVars({}).text, '')
})

test('der Anbieter fragt den Luft-Endpunkt und legt luft.* in den Vorrat', async () => {
  const urls = []
  const abruf = async (url) => { urls.push(url); return { ok: true, json: async () => ANTWORT } }
  const k = new Weltkontext({ anbieter: [luftAnbieter({ abruf })], cache: false, warn: () => {} })
  await k.frischen([zelleFuer(50.3569, 7.5890)])
  assert.equal(urls.length, 1)
  assert.match(urls[0], /^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?latitude=50\.4000&longitude=7\.6000/)
  assert.match(urls[0], /european_aqi/)
  assert.match(urls[0], /birch_pollen/)
  assert.equal(k.varsFuer(50.3569, 7.5890).luft.text, 'mäßig')
})
