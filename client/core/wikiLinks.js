// client/core/wikiLinks.js — vertrauenswürdige Wikimedia-Links aus Objekt-Daten.
//
// Sicherheits-Entscheidung (2026-08-11): Links aus Objekt-Daten werden im UI
// vorerst NUR für Wikipedia-/Commons-Objekte anklickbar gemacht und NUR, wenn
// sie auf Wikimedia-Hosts zeigen — Nutzer-/Agent-Beschreibungen sollen keine
// beliebigen (Phishing-)Links in die Spieloberfläche schleusen können.

/** true, wenn die URL https auf einen Wikimedia-Host ist. */
export function isWikimediaUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.protocol === 'https:' && (
      u.hostname === 'commons.wikimedia.org'
      || u.hostname.endsWith('.wikipedia.org')
      || u.hostname.endsWith('.wikimedia.org')
    )
  } catch { return false }
}

/**
 * Öffenbarer Link eines Wikipedia-/Commons-Objekts oder null.
 * Nur für Objekte mit state.source === "wikipedia" und Wikimedia-Host.
 */
export function wikiLinkOf(record) {
  if (record?.state?.source !== 'wikipedia') return null
  const raw = record?.state?.url
  return typeof raw === 'string' && isWikimediaUrl(raw) ? raw : null
}
