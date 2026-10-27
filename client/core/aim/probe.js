// probe — does JavaScript keep up with the screen off?
//
// THE question the design depends on (docs/geraete-anbindung.md): target
// selection runs in the WebView. The foreground service keeps the CPU and
// BLE awake, but Android may throttle or pause the page when the screen is
// off. If events from the native side arrive seconds late, pointing in the
// pocket does not work, whatever else is built.
//
// The native side posts ticks at `hz` for `seconds` (AimDevicesPlugin
// .startProbe). This side records when each arrives, and runs its own timer
// next to it. The player switches the screen off during the run.

/**
 * @param {object} plugin   the AimDevices plugin
 * @param {{hz?:number, seconds?:number}} [opts]
 * @returns {Promise<object>} statistics, see summarise()
 */
export async function runProbe(plugin, { hz = 20, seconds = 60 } = {}) {
  const arrivals = []
  const timer = []
  const handle = await plugin.addListener('probe', (e) => arrivals.push({ seq: e.seq, sent: e.t, got: Date.now() }))
  const iv = setInterval(() => timer.push(Date.now()), 1000 / hz)
  let expected = hz * seconds
  try {
    const r = await plugin.startProbe({ hz, seconds })
    if (Number.isFinite(r?.expected)) expected = r.expected
    await new Promise(res => setTimeout(res, seconds * 1000 + 1500))
  } finally {
    clearInterval(iv)
    try { handle.remove() } catch {}
  }
  return summarise({ arrivals, timer, expected, hz, seconds })
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null

/** Pure, for tests: what the numbers mean. */
export function summarise({ arrivals, timer, expected, hz, seconds }) {
  const delays = arrivals.map(a => a.got - a.sent).sort((a, b) => a - b)
  const gotTimes = arrivals.map(a => a.got).sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < gotTimes.length; i++) maxGap = Math.max(maxGap, gotTimes[i] - gotTimes[i - 1])
  let maxTimerGap = 0
  for (let i = 1; i < timer.length; i++) maxTimerGap = Math.max(maxTimerGap, timer[i] - timer[i - 1])
  const received = arrivals.length
  const median = pct(delays, 0.5), p95 = pct(delays, 0.95)
  // Pointing needs ~10 samples a second with well under half a second of lag.
  const ok = received >= expected * 0.9 && (p95 ?? Infinity) <= 300 && maxGap <= 1000
  return {
    expected, received, ratio: expected ? received / expected : 0,
    delayMedianMs: median, delayP95Ms: p95, delayMaxMs: delays.at(-1) ?? null,
    maxGapMs: maxGap, timerTicks: timer.length, timerExpected: Math.round(hz * seconds), maxTimerGapMs: maxTimerGap,
    verdict: ok ? 'ok' : received < expected * 0.5 || maxGap > 5000 ? 'blocked' : 'degraded',
  }
}

/** One line for the message log. */
export function describeProbe(s) {
  const v = { ok: 'trägt', degraded: 'trägt eingeschränkt', blocked: 'trägt NICHT' }[s.verdict]
  return `Messung Bildschirm aus: ${v} — ${s.received}/${s.expected} Ereignisse, Verzögerung Median ${s.delayMedianMs ?? '–'} ms, `
    + `95 % ${s.delayP95Ms ?? '–'} ms, größte Lücke ${s.maxGapMs} ms; JS-Takt ${s.timerTicks}/${s.timerExpected}, größte Lücke ${s.maxTimerGapMs} ms`
}
