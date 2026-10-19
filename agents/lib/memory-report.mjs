// memory-report.mjs — an agent says how much memory it uses, and says it out
// loud before it becomes someone else's problem.
//
// WHY THIS EXISTS. The Ajna server is a 2 GB VPS. In October 2026 PocketBase
// was killed there repeatedly and the whole machine hung until a reboot. The
// cause was not visible anywhere: the agents log what they DO, never what they
// COST, so a slow leak looks exactly like a healthy process until the kernel
// steps in. `world-director` had grown from 99 MB to 203 MB in eight minutes
// and nothing in any log said so.
//
// A LIMIT THAT NOBODY CAN SEE IS A TRAP, NOT A LIMIT. That is the whole idea
// here. Capping an agent's heap makes the machine survive, but it also makes
// the agent slower or kills it outright — and if that happens silently, the
// operator is left with "it was sluggish yesterday". So every budget comes
// with a line in the log, and crossing a mark is a warning, not a statistic.
//
// RSS IS THE NUMBER THAT MATTERS TO THE MACHINE, the heap is the number that
// explains it. Both are reported: the kernel kills on RSS, but a growing heap
// tells you it is your own data structure and not the runtime.

import v8 from 'node:v8'

const MB = 1024 * 1024

/** Current usage in megabytes, rounded to something a human reads. */
export function memoryUsage() {
  const m = process.memoryUsage()
  const r = (v) => Math.round((v / MB) * 10) / 10
  return {
    rss: r(m.rss),               // what the machine must find room for
    heapUsed: r(m.heapUsed),     // what this process actually holds
    heapTotal: r(m.heapTotal),   // what V8 has claimed for the heap
    external: r(m.external),     // buffers etc. outside the heap
    arrayBuffers: r(m.arrayBuffers ?? 0),
  }
}

/**
 * The V8 old-space limit in MB, or null if it cannot be determined.
 *
 * Worth logging at startup: it is the difference between "this agent dies
 * cleanly at 128 MB" and "this agent may grow until the kernel picks a victim".
 */
export function heapLimit() {
  try {
    const l = v8.getHeapStatistics()?.heap_size_limit
    return Number.isFinite(l) ? Math.round(l / MB) : null
  } catch { return null }
}

/** One line for a log. */
export function formatMemory(usage = memoryUsage()) {
  return `RSS ${usage.rss} MB · Heap ${usage.heapUsed}/${usage.heapTotal} MB`
    + (usage.external >= 5 ? ` · extern ${usage.external} MB` : '')
}

/**
 * Report memory at an interval, and warn when it crosses a mark.
 *
 * @param {object} opts
 * @param {(msg: string) => void} [opts.log]       normal lines
 * @param {(msg: string) => void} [opts.warn]      the crossing of a mark
 * @param {number} [opts.intervalMs=600000]        how often to report
 * @param {number} [opts.warnAtMb=0]               RSS at which to warn; 0 = never
 * @param {() => string} [opts.extra]              a caller's own figures, appended
 * @param {boolean} [opts.unref=true]              do not keep the process alive
 * @returns {{ stop: () => void, report: () => void }}
 */
export function startMemoryReport(opts = {}) {
  const {
    log = (m) => console.log(m),
    warn = (m) => console.warn(m),
    intervalMs = 600_000,
    warnAtMb = 0,
    extra = null,
    unref = true,
  } = opts

  // A GROWTH FIGURE, NOT JUST A LEVEL. 180 MB means nothing on its own; "180 MB,
  // was 120 MB ten minutes ago" is the whole diagnosis. The start value stays
  // as the baseline so a long-running agent still shows its drift.
  const start = memoryUsage().rss
  let previous = start
  // Warn ONCE per crossing, not on every tick: a log that repeats the same
  // warning every ten minutes gets filtered out, and then it warns nobody.
  let warned = false

  const report = () => {
    const u = memoryUsage()
    const delta = Math.round((u.rss - previous) * 10) / 10
    const seit = Math.round((u.rss - start) * 10) / 10
    previous = u.rss
    const trend = delta === 0 ? '' : ` · ${delta > 0 ? '+' : ''}${delta} MB seit der letzten Meldung`
    const drift = seit === 0 ? '' : ` · ${seit > 0 ? '+' : ''}${seit} MB seit dem Start`
    log(`[speicher] ${formatMemory(u)}${trend}${drift}${extra ? ` · ${extra()}` : ''}`)

    if (warnAtMb > 0 && u.rss >= warnAtMb && !warned) {
      warned = true
      warn(`[speicher] ÜBER DER MARKE: ${u.rss} MB ≥ ${warnAtMb} MB. `
        + `Heap ${u.heapUsed}/${u.heapTotal} MB${heapLimit() ? `, Grenze ${heapLimit()} MB` : ''}. `
        + `Wächst das weiter, trifft es den ganzen Server.`)
    } else if (warnAtMb > 0 && u.rss < warnAtMb * 0.9) {
      warned = false   // deutlich darunter → beim nächsten Mal wieder warnen
    }
  }

  const h = setInterval(report, intervalMs)
  if (unref) h.unref?.()
  return { stop: () => clearInterval(h), report }
}
