// wetter.mjs — Wetter als sprechfertige Werte, aus Open-Meteo.
//
// QUELLE: api.open-meteo.com. Kein Schlüssel, keine Anmeldung, für
// nicht-kommerzielle Nutzung frei (CC-BY-4.0). Ein Aufruf liefert das aktuelle
// Wetter, Sonnenauf- und -untergang und den UV-Höchstwert des Tages — also
// alles, was ein NPC-Satz braucht, in einer Anfrage je Zelle und Viertelstunde.
//
// WARUM NICHT DER DEUTSCHE WETTERDIENST: Dessen offene Daten sind Rasterdateien
// und Stationsmessungen, keine Punktabfrage. Der Weg dorthin ist ein eigenes
// Projekt; Open-Meteo rechnet unter anderem mit ICON-Daten desselben Dienstes.
//
// SPRECHFERTIG, NICHT ROH: `wetter.text` ist „leichter Regen", nicht `61`.
// Parley setzt ein, es rechnet nicht — ein WMO-Code in einem Dialogsatz wäre
// für den Spieler unlesbar und für den Dialogautor unbrauchbar.

import { himmelVars } from './himmel.mjs'

/**
 * WMO-Wettercodes in deutsche Wendungen.
 *
 * Bewusst KURZ und in der Form, die in einen Satz passt: „Draussen ist
 * {wetter.text}." Deshalb Kleinschreibung und kein Artikel — der steht im
 * Dialog, wo der Autor ihn beugen kann.
 */
export const WMO_TEXT = {
  0: 'klarer Himmel',
  1: 'überwiegend klar', 2: 'wechselnd bewölkt', 3: 'bedeckter Himmel',
  45: 'Nebel', 48: 'gefrierender Nebel',
  51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'dichter Nieselregen',
  56: 'gefrierender Niesel', 57: 'gefrierender Niesel',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen',
  66: 'gefrierender Regen', 67: 'gefrierender Regen',
  71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall',
  77: 'Schneegriesel',
  80: 'Regenschauer', 81: 'kräftige Schauer', 82: 'heftige Schauer',
  85: 'Schneeschauer', 86: 'kräftige Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'schweres Gewitter mit Hagel',
}

/** Codes, bei denen es von oben nass wird — für `{if: {"wetter.regen": true}}`. */
const NASS = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99])
/** Codes mit Schnee — eigener Merker, weil sich das anders anfühlt als Regen. */
const SCHNEE = new Set([71, 73, 75, 77, 85, 86])
/** Gewitter: der einzige Code, der eine Warnung wert ist. */
const GEWITTER = new Set([95, 96, 99])

/** Windstärke in Worten — „steife Brise" sagt mehr als „28 km/h". */
export function windText(kmh) {
  const v = Number(kmh)
  if (!Number.isFinite(v)) return ''
  if (v < 2) return 'windstill'
  if (v < 12) return 'leichter Wind'
  if (v < 29) return 'frischer Wind'
  if (v < 50) return 'starker Wind'
  if (v < 75) return 'Sturm'
  return 'Orkan'
}

/**
 * Antwort von Open-Meteo in `wetter.*`-Variablen übersetzen.
 *
 * Eigene Funktion, damit sie ohne Netz geprüft werden kann — die Übersetzung
 * ist der Teil, der falsch sein kann, nicht das `fetch`.
 */
export function wetterVars(antwort) {
  const c = antwort?.current || {}
  const d = antwort?.daily || {}
  const code = Number(c.weather_code)
  const sonne = {
    sonnenaufgang: Array.isArray(d.sunrise) ? d.sunrise[0] : null,
    sonnenuntergang: Array.isArray(d.sunset) ? d.sunset[0] : null,
  }
  const grad = Number(c.temperature_2m)
  return {
    text: WMO_TEXT[code] || 'unbestimmtes Wetter',
    grad: Number.isFinite(grad) ? Math.round(grad) : null,
    gefuehlt: Number.isFinite(Number(c.apparent_temperature))
      ? Math.round(Number(c.apparent_temperature)) : null,
    regen: NASS.has(code),
    schnee: SCHNEE.has(code),
    gewitter: GEWITTER.has(code),
    wind: windText(c.wind_speed_10m),
    wind_kmh: Number.isFinite(Number(c.wind_speed_10m)) ? Math.round(Number(c.wind_speed_10m)) : null,
    uv: Array.isArray(d.uv_index_max) && Number.isFinite(Number(d.uv_index_max[0]))
      ? Math.round(Number(d.uv_index_max[0])) : null,
    // Sonnenzeiten kommen aus derselben Antwort und werden MITGESPEICHERT — sie
    // gelten den ganzen Tag. Tageszeit und Mond werden daraus erst beim
    // Sprechen gerechnet (siehe `abgeleitet` unten).
    sonne,
  }
}

const URL_BASIS = 'https://api.open-meteo.com/v1/forecast'

/**
 * Der Anbieter für `Weltkontext`.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]   wie lange ein Wert gilt (Vorgabe 15 Minuten —
 *                                der Takt aus docs/welt-kontext.md)
 * @param {Function} [opts.abruf] nur für Tests: ersetzt `fetch`
 */
export function wetterAnbieter({ ttlMs = 15 * 60_000, abruf = fetch, timeoutMs = 15_000 } = {}) {
  return {
    name: 'wetter',
    ttlMs,
    async hole({ lat, lon }) {
      const url = `${URL_BASIS}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
        + '&daily=sunrise,sunset,uv_index_max&timezone=auto&forecast_days=1'
      // Ohne Zeitgrenze haengt der Takt am langsamsten Aufruf, und der naechste
      // Durchlauf laeuft in den vorigen hinein.
      const stop = AbortSignal.timeout(timeoutMs)
      const r = await abruf(url, { signal: stop, headers: { 'User-Agent': 'Ajna/1.0 (+weltkontext)' } })
      if (!r.ok) throw new Error(`Open-Meteo antwortet ${r.status}`)
      return wetterVars(await r.json())
    },
    // BEIM SPRECHEN GERECHNET, nicht beim Holen.
    //
    // „Abend" fünfzehn Minuten lang einzufrieren wäre genau die Art kleiner
    // Unstimmigkeit, an der ein NPC auffliegt: Um 19:59 sagt er „Nachmittag",
    // weil der Wert um 19:44 geholt wurde. Mondphase und Tageszeit sind
    // Arithmetik und kosten nichts — also werden sie in dem Moment gerechnet,
    // in dem jemand fragt. Aus dem Vorrat kommen nur die Sonnenzeiten, und die
    // gelten den ganzen Tag.
    abgeleitet: (werte) => ({ himmel: himmelVars(new Date(), werte?.sonne || {}) }),
  }
}
