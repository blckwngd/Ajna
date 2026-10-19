// bounded-cache.mjs — an in-memory cache that cannot outgrow its budget.
//
// WHY THIS EXISTS. `world-director` kept road graphs in a plain `Map`, keyed by
// a 300 m cell, with a one-hour TTL. The TTL decided whether an entry was
// REUSED — it never removed anything. So every cell a player ever walked
// through kept its full way graph for the lifetime of the process. Measured on
// 19.10.2026: the director grew from 99 MB to 203 MB in eight minutes. On a
// 2 GB VPS that is the difference between a stable backend and a hung machine.
//
// A TTL ALONE IS NOT A BUDGET. That is the whole point of this file. Expiry
// bounds how OLD an entry may be, not how MANY there are: a player crossing
// the map creates new cells faster than the old ones expire, and every one of
// them is live until its hour is up. Only a hard cap on the number of entries
// gives a ceiling you can multiply by the entry size and put in a budget.
//
// So both limits are enforced, and they answer different questions:
//   ttlMs      — "is this still true?"      (correctness)
//   maxEntries — "can this still fit?"      (survival)
//
// Least-recently-USED, not least-recently-written: a cell the figures keep
// walking through should survive a tour through the suburbs. `Map` iterates in
// insertion order, so a read re-inserts its key to move it to the young end.
//
// The clock is injectable so the tests can age entries without sleeping.

/**
 * @template K, V
 */
export class BoundedCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=64]  hard ceiling; the least recently used
   *   entry is dropped when a new one does not fit. Must be >= 1.
   * @param {number} [opts.ttlMs=0]        age at which an entry stops counting
   *   as valid; 0 disables expiry (the cap still applies).
   * @param {() => number} [opts.now]      clock, for tests.
   * @param {(key: K, value: V, reason: 'expired'|'evicted'|'replaced') => void} [opts.onEvict]
   *   called when an entry leaves other than by `delete`/`clear` — useful for
   *   releasing something attached to the value, and for counting in a log.
   */
  constructor(opts = {}) {
    const { maxEntries = 64, ttlMs = 0, now = () => Date.now(), onEvict = null } = opts
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new Error('BoundedCache: maxEntries must be a finite number >= 1')
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('BoundedCache: ttlMs must be a finite number >= 0')
    }
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this._now = now
    this._onEvict = onEvict
    /** @type {Map<K, {value: V, at: number}>} */
    this._map = new Map()
    // Counters worth logging: they are how an operator notices that a cache is
    // too small for its job (constant evictions) rather than merely warm.
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.expirations = 0
  }

  get size() { return this._map.size }

  _expired(entry) {
    return this.ttlMs > 0 && (this._now() - entry.at) >= this.ttlMs
  }

  _leave(key, entry, reason) {
    this._map.delete(key)
    if (reason === 'expired') this.expirations++
    else if (reason === 'evicted') this.evictions++
    if (this._onEvict) this._onEvict(key, entry.value, reason)
  }

  /**
   * The value, or `undefined` if absent or expired. An expired entry is
   * removed on the way out — a read is the cheapest moment to notice.
   */
  get(key) {
    const entry = this._map.get(key)
    if (!entry) { this.misses++; return undefined }
    if (this._expired(entry)) { this._leave(key, entry, 'expired'); this.misses++; return undefined }
    // Re-insert to mark it as recently used. `Map` has no other way to reorder.
    this._map.delete(key)
    this._map.set(key, entry)
    this.hits++
    return entry.value
  }

  /** Like `get`, but without counting a hit or refreshing the usage order. */
  peek(key) {
    const entry = this._map.get(key)
    if (!entry || this._expired(entry)) return undefined
    return entry.value
  }

  /** `true` only for an entry that `get` would hand out. */
  has(key) { return this.peek(key) !== undefined }

  /**
   * Store a value. Writing an existing key refreshes its age and its place in
   * the usage order. Once the cap is reached the least recently used entry
   * leaves — never the one just written.
   */
  set(key, value) {
    const old = this._map.get(key)
    if (old) {
      this._map.delete(key)
      if (this._onEvict && old.value !== value) this._onEvict(key, old.value, 'replaced')
    }
    this._map.set(key, { value, at: this._now() })

    // Expired entries first: dropping something stale is free, dropping
    // something merely old is a loss. Only then fall back to the oldest use.
    if (this._map.size > this.maxEntries) this.prune()
    while (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next()
      if (oldest.done) break
      this._leave(oldest.value, this._map.get(oldest.value), 'evicted')
    }
    return this
  }

  delete(key) { return this._map.delete(key) }

  clear() { this._map.clear() }

  /** Drop every expired entry. Returns how many went. */
  prune() {
    if (this.ttlMs <= 0) return 0
    let gone = 0
    for (const [key, entry] of [...this._map]) {
      if (this._expired(entry)) { this._leave(key, entry, 'expired'); gone++ }
    }
    return gone
  }

  /** Keys of the valid entries, least recently used first. */
  keys() { return [...this._map].filter(([, e]) => !this._expired(e)).map(([k]) => k) }

  /** Valid values, least recently used first. */
  values() { return [...this._map].filter(([, e]) => !this._expired(e)).map(([, e]) => e.value) }

  /** One line for a log: how well the cache is doing its job. */
  stats() {
    const total = this.hits + this.misses
    const quote = total ? Math.round((this.hits / total) * 100) : 0
    return `${this.size}/${this.maxEntries} Einträge · ${quote} % Treffer `
      + `(${this.hits}/${total}) · ${this.evictions} verdrängt · ${this.expirations} verfallen`
  }
}

/** Convenience: `new BoundedCache(opts)` without the `new`. */
export const boundedCache = (opts) => new BoundedCache(opts)
