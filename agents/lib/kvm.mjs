// kvm.mjs — Karte von Morgen: Initiativen, Projekte und Unternehmen, die
// Unterstützung verdienen.
//
// WOZU. Die anderen Quellen dieses Agenten sagen, was WO ist: eine Bank, ein
// Denkmal, ein Wikipedia-Artikel. Diese sagt, was jemand für UNTERSTÜTZENSWERT
// hält — ein Repair-Café, eine solidarische Landwirtschaft, ein Unternehmen,
// das anders wirtschaftet. Das ist keine Kartierung, das ist eine Empfehlung,
// und sie wird auch so dargestellt.
//
// DIE QUELLE. openfairdb (AGPL) hinter kartevonmorgen.org, API unter
// `https://api.ofdb.io/v0`. Kein Schlüssel, kein Kontingent, Abfrage über eine
// BBOX. Jeder Eintrag trägt SEINE EIGENE LIZENZ (`CC0-1.0` oder `ODbL-1.0`) —
// das ist kein Beiwerk, sondern eine Angabe, die mitwandern muss.
//
// BEWERTUNGEN SIND MEINUNGEN, KEINE MESSWERTE. Die sieben Werte (Vielfalt,
// Fairness, Menschlichkeit, Erneuerbarkeit, Solidarität, Transparenz) kommen
// von Besuchern der Karte. Sie taugen, um auf etwas aufmerksam zu machen; sie
// taugen nicht als Tatsachenbehauptung über einen Betrieb. Deshalb erscheinen
// sie als „von Besuchern bewertet", nie als Eigenschaft.
//
// Die Übersetzung liegt hier und ist ohne Netz prüfbar — dieselbe Trennung wie
// bei `cits.mjs` und `aprs.mjs`.

/** Die drei Kategorien, die openfairdb kennt (per /v0/categories geprüft). */
export const KATEGORIEN = {
  '2cd00bebec0c48ba9db761da48678134': { key: 'initiative', label: 'Initiative', emoji: '🌱' },
  '77b3c33a92554bcf8e8c2c86cedd6f6f': { key: 'business', label: 'Unternehmen', emoji: '🤝' },
  'c2dc278a2d6a4b9b8a50cb606fc017ed': { key: 'event', label: 'Veranstaltung', emoji: '📅' },
}

/** Die Bewertungsachsen, in der Reihenfolge, in der sie jemand vorlesen würde. */
export const ACHSEN = {
  solidarity: 'Solidarität',
  fairness: 'Fairness',
  humanity: 'Menschlichkeit',
  renewable: 'Erneuerbarkeit',
  transparency: 'Transparenz',
  diversity: 'Vielfalt',
}

/** Welche Art ist das? Mehrere Kategorien kommen vor; die erste bekannte zählt. */
export function artVon(eintrag) {
  for (const id of eintrag?.categories || []) {
    if (KATEGORIEN[id]) return KATEGORIEN[id]
  }
  return { key: 'other', label: 'Eintrag', emoji: '📍' }
}

/**
 * Taugt der Eintrag?
 *
 * VERANSTALTUNGEN BLEIBEN DRAUSSEN, solange es keine Lebensdauer für Objekte
 * gibt (`state.expires_at`, docs/arbeitspakete.md Paket 5a). Ein Termin, der
 * nicht von selbst verschwindet, ist in einem Monat Müll — und in einem Jahr
 * eine Lüge über etwas, das längst vorbei ist.
 */
export function brauchbar(eintrag, opts = {}) {
  const { arten = null, minBewertung = 0, mitVeranstaltungen = false } = opts
  if (!eintrag?.title) return false
  // `Number(null)` IST 0, NICHT NaN. Ein Eintrag ohne Breitengrad käme damit
  // durch die Endlichkeitsprüfung und landete im Golf von Guinea — die
  // Null-Insel-Prüfung unten fängt ihn nur, wenn AUCH die Länge fehlt.
  if (eintrag.lat == null) return false
  const rohLon = eintrag.lng ?? eintrag.lon
  if (rohLon == null) return false
  const lat = Number(eintrag.lat), lon = Number(rohLon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (lat === 0 && lon === 0) return false

  const art = artVon(eintrag)
  if (art.key === 'event' && !mitVeranstaltungen) return false
  if (arten?.length && !arten.includes(art.key)) return false
  if (minBewertung > 0 && Number(eintrag.ratings?.total ?? 0) < minBewertung) return false
  return true
}

/** Die Bewertungen, die überhaupt etwas sagen — null heisst „keine". */
export function bewertungen(roh) {
  if (!roh || typeof roh !== 'object') return null
  const raus = []
  for (const [k, label] of Object.entries(ACHSEN)) {
    const v = Number(roh[k])
    if (Number.isFinite(v) && v > 0) raus.push({ key: k, label, wert: Math.round(v * 10) / 10 })
  }
  if (!raus.length) return null
  raus.sort((a, b) => b.wert - a.wert)
  return raus
}

const kurz = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Ein openfairdb-Eintrag → das, was ein Ajna-Objekt braucht.
 *
 * ERSTE ZEILE = WAS VORGELESEN WIRD (der Announcer kappt bei 100 Zeichen).
 * Darunter steht, was man liest: Beschreibung, Kontakt, Schlagworte, Herkunft.
 */
export function alsSichtung(e) {
  const art = artVon(e)
  const lat = Number(e.lat), lon = Number(e.lng ?? e.lon)
  const name = kurz(e.title, 32)

  const kopf = [art.label]
  const schlag = (e.tags || []).filter(Boolean).slice(0, 3)
  if (schlag.length) kopf.push(schlag.join(', '))

  const detail = []
  if (e.description) detail.push(kurz(e.description, 420))

  const anschrift = [e.street, [e.zip, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  if (anschrift) detail.push(`Anschrift: ${anschrift}`)
  if (e.opening_hours) detail.push(`Öffnungszeiten: ${e.opening_hours}`)
  const kontakt = [e.telephone, e.email, e.homepage].filter(Boolean)
  if (kontakt.length) detail.push(`Kontakt: ${kontakt.join(' · ')}`)
  if ((e.tags || []).length > 3) detail.push(`Schlagworte: ${e.tags.join(', ')}`)

  // AUSDRÜCKLICH ALS MEINUNG. „Solidarität 2,0" als Eigenschaft eines Betriebs
  // zu behaupten wäre eine Tatsachenaussage, die diese Zahlen nicht tragen.
  const b = bewertungen(e.ratings)
  if (b) {
    detail.push(`Von Besuchern bewertet: ${b.slice(0, 3).map(x => `${x.label} ${x.wert}`).join(' · ')}`)
  }

  // Die Lizenz wandert MIT. Sie steht je Eintrag und ist keine Fussnote des
  // Projekts, sondern eine Angabe dessen, der den Eintrag gemacht hat.
  const lizenz = e.license ? `, ${e.license}` : ''
  detail.push(`Quelle: Karte von Morgen (kartevonmorgen.org)${lizenz}`)

  return {
    name,
    lat, lon,
    description: `${kurz(kopf.join(' · '), 100)}\n\n${detail.join('\n')}`,
    appearance: { emoji: art.emoji },
    state: {
      source: 'kartevonmorgen',
      kvm_id: e.id || null,
      kvm_kind: art.key,
      label: art.label,
      moving: false,
      tags: (e.tags || []).slice(0, 12),
      homepage: e.homepage || null,
      rating_total: Number.isFinite(Number(e.ratings?.total))
        ? Math.round(Number(e.ratings.total) * 100) / 100 : null,
      license: e.license || null,
    },
  }
}

/**
 * Eine BBOX um einen Punkt, wie `/v0/search` sie erwartet: `süd,west,nord,ost`.
 *
 * Die API nimmt KEINEN Radius — wer einen Kreis will, fragt das Rechteck ab
 * und misst danach nach. Das Rechteck wird deshalb grosszügig gewählt.
 */
export function bbox(lat, lon, radiusKm) {
  // MIT ZUSCHLAG, und der ist nicht Zierde: Ein Grad Breite sind bei R=6371
  // genau 111,195 km, nicht 111,32 — mit dem grösseren Wert gerechnet fällt
  // das Rechteck knapp INNERHALB des gewünschten Radius, und Treffer am Rand
  // gehen still verloren. Ein Test hat das aufgedeckt; fünf Prozent Luft sind
  // billiger als eine Abfrage, die zu wenig liefert.
  const KM_JE_GRAD = 111.195
  const r = radiusKm * 1.05
  const dLat = r / KM_JE_GRAD
  const dLon = r / (KM_JE_GRAD * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  const rd = (v) => Math.round(v * 1e6) / 1e6
  return `${rd(lat - dLat)},${rd(lon - dLon)},${rd(lat + dLat)},${rd(lon + dLon)}`
}

/** Entfernung in km — für die Nachmessung nach der BBOX-Abfrage. */
export function abstandKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}
