// luft.mjs — Luftqualität und Pollen als sprechfertige Werte, aus Open-Meteo.
//
// QUELLE: air-quality-api.open-meteo.com — der zweite Endpunkt desselben
// Anbieters wie das Wetter (CAMS-Daten des Copernicus-Programms). Kein
// Schlüssel, stündliche Werte; eine Anfrage je Zelle und Stunde reicht,
// Luft ändert sich träge.
//
// SPRECHFERTIG, NICHT ROH: `luft.text` ist „gut" oder „schlecht", nicht
// `european_aqi: 61`. Die Stufen sind die des Europäischen Luftqualitäts-
// index (EAQI): 0–20 gut, –40 mäßig, –60 mittel, –80 schlecht, –100 sehr
// schlecht, darüber extrem. Pollen nur, wo wirklich welche fliegen — eine
// Figur, die im Oktober von Birkenpollen spricht, hat etwas falsch verstanden.

export const AQI_STUFEN = [
  [20, 'gut'], [40, 'mäßig'], [60, 'mittel'], [80, 'schlecht'], [100, 'sehr schlecht'],
]

/** EAQI in Worten. */
export function aqiText(aqi) {
  const v = Number(aqi)
  if (!Number.isFinite(v) || v < 0) return ''
  for (const [grenze, wort] of AQI_STUFEN) if (v <= grenze) return wort
  return 'extrem schlecht'
}

/** Pollenarten, wie Open-Meteo sie nennt, und wie eine Figur sie nennt. */
export const POLLEN = {
  birch_pollen: 'Birke', alder_pollen: 'Erle', grass_pollen: 'Gräser',
  mugwort_pollen: 'Beifuß', ragweed_pollen: 'Ambrosia', olive_pollen: 'Olive',
}
/** Ab hier (Körner/m³) merkt es ein Allergiker — grob die „mittlere" Belastung. */
export const POLLEN_SCHWELLE = 20

/**
 * Antwort in `luft.*` übersetzen. Eigene Funktion, damit sie ohne Netz
 * geprüft werden kann.
 */
export function luftVars(antwort) {
  const c = antwort?.current || {}
  const aqi = Number(c.european_aqi)
  const zahl = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : null)
  const fliegen = Object.entries(POLLEN)
    .map(([k, name]) => ({ name, menge: Number(c[k]) }))
    .filter(p => Number.isFinite(p.menge) && p.menge >= POLLEN_SCHWELLE)
    .sort((a, b) => b.menge - a.menge)
  return {
    aqi: Number.isFinite(aqi) ? Math.round(aqi) : null,
    text: aqiText(aqi),
    schlecht: Number.isFinite(aqi) && aqi > 60,
    pm10: zahl(c.pm10),
    pm25: zahl(c.pm2_5),
    ozon: zahl(c.ozone),
    pollen: fliegen.length > 0,
    pollen_text: fliegen.map(p => p.name).join(', '),
  }
}

const URL_BASIS = 'https://air-quality-api.open-meteo.com/v1/air-quality'

/**
 * Der Anbieter für `Weltkontext`.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]   Vorgabe 60 Minuten — Luft folgt der Sonne, nicht der Uhr
 * @param {Function} [opts.abruf] nur für Tests: ersetzt `fetch`
 */
export function luftAnbieter({ ttlMs = 60 * 60_000, abruf = fetch, timeoutMs = 15_000 } = {}) {
  return {
    name: 'luft',
    ttlMs,
    async hole({ lat, lon }) {
      const url = `${URL_BASIS}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + '&current=european_aqi,pm10,pm2_5,ozone,'
        + Object.keys(POLLEN).join(',')
        + '&timezone=auto'
      const r = await abruf(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Ajna/1.0 (+weltkontext)' } })
      if (!r.ok) throw new Error(`Open-Meteo (Luft) antwortet ${r.status}`)
      return luftVars(await r.json())
    },
  }
}
