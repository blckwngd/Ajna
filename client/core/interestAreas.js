// client/core/interestAreas.js — Interest-Areas periodisch beobachten.
//
// Das gemeinsame Muster der demand-getriebenen Agents (poi/ais/adsb/wigle):
// die (anonymisierten) Interessensbereiche der Spieler regelmäßig abfragen,
// Fehler nur warnen (Fallback entscheidet der Aufrufer), Anzahl deckeln und
// Änderungen erkennen. Der Callback bekommt die rohen Areas — wie daraus
// Abfragekästen/Zentren werden, bleibt Sache des Agents.
//
// Browserfähig (nur AjnaManager + Timer) — Agents nutzen dieselbe Datei per Node.

/**
 * @param {import('./AjnaManager.js').AjnaManager} ajna
 * @param {string} source     Filter wie bei fetchInterestAreas ('' = alle)
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=60000]
 * @param {number} [opts.maxAreas=Infinity]  Deckel (Quota-Schutz); Überschuss wird abgeschnitten
 * @param {Function} [opts.warn=console.warn]
 * @param {(areas:Array, info:{changed:boolean})=>any} cb
 *   Läuft bei JEDEM Tick (auch unverändert — Throttling entscheidet der Agent).
 *   `changed` = Areas unterscheiden sich vom vorigen Tick (reihenfolge-
 *   unabhängig, auf ~1 m gerundet). Erster Tick zählt als geändert.
 * @returns {{stop:()=>void, first:Promise<void>}}
 */
export function watchInterestAreas(ajna, source, opts, cb) {
  const { intervalMs = 60000, maxAreas = Infinity, warn = console.warn } = opts || {}
  let lastKey = null

  const areaKey = (areas) => areas
    .map(a => [a.latMin, a.lonMin, a.latMax, a.lonMax].map(v => Number(v).toFixed(5)).join(','))
    .sort().join('|')

  const tick = async () => {
    let areas = []
    try { areas = (await ajna.fetchInterestAreas(source)) || [] }
    catch (err) { warn(`[areas:${source || '*'}] ${err?.message || err} → leere Liste`) }
    if (areas.length > maxAreas) {
      warn(`[areas:${source || '*'}] ${areas.length} Bereiche → auf ${maxAreas} begrenzt`)
      areas = areas.slice(0, maxAreas)
    }
    const key = areaKey(areas)
    const changed = key !== lastKey
    lastKey = key
    // lastKey bewusst VOR dem Callback gesetzt: wirft cb, gilt der Stand
    // trotzdem als gesehen (kein Retry-Sturm; Staleness-Logik macht der Agent).
    await cb(areas, { changed })
  }

  const run = () => tick().catch(err => warn(`[areas:${source || '*'}] tick: ${err?.message || err}`))
  const timer = setInterval(run, intervalMs)
  return { stop: () => clearInterval(timer), first: run() }
}
