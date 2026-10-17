// network-trace.mjs — von einer Webseite zu dem, was hinter ihr steht.
//
// WOZU. Die Adress-Lupe weiss, welcher Betrieb an einer Anschrift sitzt und
// welche Webseite er angibt. Diese Datei beantwortet die Anschlussfrage: Wo
// läuft diese Webseite eigentlich, und wem gehört die Maschine?
//
// DIE RICHTUNG IST ENTSCHEIDEND — und sie ist umgekehrt zu dem, was man
// zuerst versucht. Nicht „welche Geräte sind an diesen Koordinaten erreichbar"
// (das beantwortet nur GeoIP, auf Stadtebene, und trifft dabei Privatanschlüsse),
// sondern „dieser Betrieb nennt diese Domain, wohin zeigt sie". Der Unterschied
// ist nicht Geschmack:
//
//   * Die Kette beginnt bei etwas VERÖFFENTLICHTEM — einem OSM-Eintrag und
//     einer eigenen Domain. Wer keine hat, kommt gar nicht erst vor. Damit
//     fallen die privaten Anschlüsse strukturell heraus, statt gefiltert zu
//     werden.
//   * Jeder Schritt ist BELEGBAR: DNS-Auflösung und Registereintrag, beides
//     öffentlich und nachprüfbar. Keine Schätzung.
//
// DREI FÄLLE, und sie dürfen nicht vermischt werden:
//
//   eigen    Die Organisation hält den Netzbereich selbst (RIPE: `ASSIGNED PI`
//            o. ä.). Dann IST die Registeranschrift ihre Anschrift.
//   gehostet Der Normalfall. Die IP gehört Strato, IONOS, Hetzner … — eine
//            wahre Aussage über den Hoster, KEINE über den Betrieb.
//   hinter   Ein CDN steht davor (Cloudflare, Akamai …). Die Adresse ist dann
//     einem  ein Netzknoten irgendwo, und ihr Ort bedeutet gar nichts.
//
// Wer die drei gleich darstellt, behauptet dreimal dasselbe und hat zweimal
// unrecht.
//
// Ein- und Ausgabe werden HEREINGEREICHT (`resolve4`, `rdapOf`, …), damit die
// Übersetzung ohne Netz prüfbar ist — dieselbe Trennung wie bei `cits.mjs`.

/**
 * Betreiber, hinter denen eine Webseite nur STECKT.
 *
 * Eine Liste, die altert — sie ist eine Momentaufnahme des Marktes, kein
 * Naturgesetz. Was hier fehlt, erscheint als gewöhnlicher Hoster; das ist der
 * harmlosere Fehler, denn die Aussage „liegt bei X" bleibt wahr.
 */
export const CDNS = [
  { name: 'Cloudflare', owner: /cloudflare/i, cname: /\.cloudflare\.net$|\.cdn\.cloudflare\.net$/i },
  { name: 'Akamai', owner: /akamai/i, cname: /\.akamaiedge\.net$|\.akamai\.net$|\.edgekey\.net$|\.edgesuite\.net$/i },
  { name: 'Fastly', owner: /fastly/i, cname: /\.fastly\.net$|\.fastlylb\.net$/i },
  { name: 'Amazon CloudFront', owner: /cloudfront/i, cname: /\.cloudfront\.net$/i },
  { name: 'Microsoft Azure CDN', owner: /microsoft|azure/i, cname: /\.azureedge\.net$|\.azurefd\.net$/i },
  { name: 'Google Cloud CDN', owner: /google/i, cname: /\.googlehosted\.com$|\.ghs\.googlehosted\.com$/i },
  { name: 'Bunny', owner: /bunny/i, cname: /\.b-cdn\.net$|\.bunnycdn\.com$/i },
  { name: 'KeyCDN', owner: /keycdn/i, cname: /\.kxcdn\.com$/i },
]

/**
 * Netzbereiche, die eine Organisation SELBST hält.
 *
 * `ASSIGNED PI` (provider independent) ist das deutlichste Zeichen; `ASSIGNED PA`
 * kommt sowohl bei Geschäftskunden als auch in Verbraucher-Pools vor und zählt
 * deshalb nur mit weiteren Anzeichen.
 */
const EIGEN_TYPEN = /^(ASSIGNED PI|ALLOCATED PA|ALLOCATED PI|DIRECT ASSIGNMENT)$/i

/**
 * Netznamen, die einen VERBRAUCHER-Anschluss verraten.
 *
 * Deren Registeranschrift ist die Konzernzentrale des Anbieters, niemals die
 * des Anschlussinhabers. Solche Treffer dürfen nie verortet werden — sie sind
 * genau die Privatwohnungen, um die es bei dieser Quelle nicht gehen soll.
 */
const VERBRAUCHER = /(-|^)(DIAL|DIALUP|POOL|CUSTOMER|CUST|DYN|DYNAMIC|DSL|CABLE|MOBILE|RESIDENTIAL|BROADBAND)(-|\d|$)/i

/**
 * Den Inhaber aus einer RDAP-Antwort holen — und zwar NUR die Organisation.
 *
 * ZWEI FALLEN, beide an echten Datensätzen aufgefallen (16.10.2026):
 *
 * 1. WARTUNGS-HANDLES SIND KEINE INHABER. Bei `193.99.144.0/24` tragen vier
 *    Einträge die Rolle `registrant`, drei davon heissen `IPH-MNT`,
 *    `PLUSLINE-MNT`, `RIPE-NCC-END-MNT` — Maintainer-Objekte ohne Anschrift.
 *    Wer den ersten nimmt, schreibt „eingetragen auf IPH-MNT" und hat nichts
 *    gesagt. Der richtige Eintrag ist `ORG-HGGC1-RIPE`, Heise Gruppe GmbH.
 *
 * 2. DER ADMINISTRATIVE KONTAKT IST EIN MENSCH. Im selben Datensatz steht
 *    `kind: "individual"`, „Alfons Schraeder", mit vollständiger Anschrift.
 *    Das ist eine natürliche Person, die im Register steht, weil jemand
 *    erreichbar sein muss — nicht, damit ein Spiel sie anzeigt.
 *
 * Deshalb die harte Regel: **nur `kind: "org"`**. Findet sich keine
 * Organisation, bleibt der Netzname ohne Inhaber — eine ehrliche Lücke ist
 * besser als ein Name, der dort nicht hingehört.
 */
export function ownerFromRdap(rd) {
  if (!rd || typeof rd !== 'object') return null
  const felderVon = (e) => {
    const v = Array.isArray(e?.vcardArray?.[1]) ? e.vcardArray[1] : []
    const hol = (k) => v.find(x => Array.isArray(x) && x[0] === k)
    return {
      kind: hol('kind')?.[3] || null,
      fn: hol('fn')?.[3] || null,
      address: hol('adr')?.[1]?.label || null,
    }
  }
  let name = null, address = null
  for (const e of rd.entities || []) {
    const f = felderVon(e)
    if (f.kind !== 'org' || !f.fn) continue
    // Die erste Organisation mit Anschrift gewinnt; eine ohne nehmen wir nur,
    // falls gar keine bessere kommt.
    if (!name || (!address && f.address)) { name = f.fn; address = f.address }
    if (address) break
  }
  return {
    name,
    address,
    netname: rd.name || null,
    type: rd.type || null,
    handle: rd.handle || null,
  }
}

/** Den Hostnamen aus einer Webseiten-Angabe holen; `null`, wenn unbrauchbar. */
export function hostFromUrl(url) {
  const roh = String(url || '').trim()
  if (!roh) return null
  let host
  try {
    const u = new URL(roh.startsWith('http') ? roh : `https://${roh}`)
    host = u.hostname.replace(/\.$/, '').toLowerCase()
  } catch { return null }
  // MUSS WIE EIN NAME AUSSEHEN. `new URL()` ist grosszügig: Aus dem Unsinn
  // „ht!tp://%%%" wird klaglos der Hostname „ht!tp". Ohne diese Prüfung ginge
  // darauf eine DNS-Anfrage — OSM-Einträge sind von Hand gepflegt, und Unsinn
  // steht dort regelmässig.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null
  if (host.length > 253) return null
  return host
}

/**
 * Steht ein CDN davor?
 * @param {{ownerName?:string, cnames?:string[]}} hinweise
 * @returns {{name:string, grund:string}|null}
 */
export function detectCdn({ ownerName = '', cnames = [] } = {}) {
  for (const c of CDNS) {
    // Der CNAME ist das verlässlichere Zeichen: Er sagt, WOHIN der Betrieb
    // selbst zeigt. Der Registername der IP kann auch ein Wiederverkäufer sein.
    const treffer = cnames.find(n => c.cname.test(String(n || '')))
    if (treffer) return { name: c.name, grund: `CNAME auf ${treffer}` }
  }
  for (const c of CDNS) {
    if (ownerName && c.owner.test(ownerName)) return { name: c.name, grund: `Netzbereich von ${ownerName}` }
  }
  return null
}

/**
 * Welcher der drei Fälle liegt vor?
 * @returns {'cdn'|'eigen'|'gehostet'|'verbraucher'}
 */
export function classify({ cdn = null, owner = null, orgName = null } = {}) {
  if (cdn) return 'cdn'
  const netname = String(owner?.netname || '')
  if (VERBRAUCHER.test(netname)) return 'verbraucher'
  // „Eigen" heisst: Der Registerinhaber IST der Betrieb — nicht nur ein
  // Netzbereich mit passendem Typ. Ohne Namensabgleich wäre jeder
  // Hosting-Block „eigen", und die Anschrift wäre die des Hosters.
  if (orgName && owner?.name && EIGEN_TYPEN.test(owner.type || '') && namesMatch(owner.name, orgName)) {
    return 'eigen'
  }
  return 'gehostet'
}

/**
 * Heissen die beiden plausibel gleich?
 *
 * Grosszügig genug für „Heise Gruppe GmbH & Co. KG" gegen „Heise Medien", eng
 * genug, um nicht jeden Hoster passend zu finden: Es muss ein unterscheidendes
 * Wort übereinstimmen, und Rechtsformen zählen nicht als solches.
 */
export function namesMatch(a, b) {
  const woerter = (s) => String(s || '').toLowerCase()
    .replace(/[^a-zäöüß0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !/^(gmbh|mbh|aktiengesellschaft|kgaa|ohg|gbr|verein|stiftung|group|gruppe|holding|deutschland|germany|international)$/.test(w))
  const A = new Set(woerter(a))
  for (const w of woerter(b)) if (A.has(w)) return true
  return false
}

/**
 * Erreichbare Dienste aus einer Shodan-Host-Antwort.
 *
 * WAS HIER BEWUSST FEHLT: die Schwachstellenliste (`vulns`). Der Zweck dieser
 * Lupe ist zu zeigen, WIE VIEL offen herumliegt — das leisten offene Ports und
 * erkannte Dienste vollständig. Eine CVE-Liste fügt dieser Einsicht nichts
 * hinzu und macht aus einer Vorführung eine Zielliste. Wer sie trotzdem will,
 * trifft diese Entscheidung bewusst und ändert diese Stelle.
 *
 * Aufgerufen wird das NUR für den Fall „eigen" — siehe `networkTrace`.
 */
export function shodanServices(rec) {
  const daten = Array.isArray(rec?.data) ? rec.data : []
  const ports = new Map()
  for (const d of daten) {
    const p = Number(d?.port)
    if (!Number.isFinite(p)) continue
    const dienst = [d?.product, d?.version].filter(Boolean).join(' ').trim()
    // Den aussagekräftigsten Eintrag je Port behalten: Shodan liefert für
    // denselben Port mehrere Aufnahmen, manche ohne erkanntes Produkt.
    if (!ports.has(p) || (!ports.get(p) && dienst)) ports.set(p, dienst)
  }
  for (const p of (Array.isArray(rec?.ports) ? rec.ports : [])) {
    if (Number.isFinite(Number(p)) && !ports.has(Number(p))) ports.set(Number(p), '')
  }
  if (!ports.size) return null

  const zeit = daten.map(d => d?.timestamp).filter(Boolean).sort().pop()
  return {
    text: [...ports.entries()].sort((a, b) => a[0] - b[0])
      .map(([p, d]) => (d ? `${p} (${d})` : String(p))).join(', '),
    anzahl: ports.size,
    stand: zeit ? String(zeit).slice(0, 10) : null,
  }
}

// ─── Die Gegenrichtung: Organisation → eigene Netzbereiche ───────────────
//
// DIE LÜCKE, DIE DAS SCHLIESST: Hält ein Unternehmen einen eigenen Netzbereich,
// lässt seine Webseite aber bei einem Hoster laufen, sieht die Kette oben
// diesen Bereich NIE — sie geht Webseite → DNS → IP und endet beim Hoster.
//
// Die RIPE-Datenbank lässt sich rückwärts befragen, und zwar in zwei Schritten:
// erst das `organisation`-Objekt zum Namen, dann die `inetnum`-Objekte, die auf
// dessen Handle zeigen (`inverse-attribute=org`). Der Umweg über das Handle ist
// nicht Umständlichkeit, sondern Genauigkeit: Eine Freitextsuche nach „Müller
// GmbH" trifft halb Deutschland, ein ORG-Handle genau eine Organisation.

/** `organisation`-Objekte aus einer RIPE-Suchantwort. */
export function orgHandles(ripeJson) {
  const raus = []
  for (const o of ripeJson?.objects?.object || []) {
    const a = Array.isArray(o?.attributes?.attribute) ? o.attributes.attribute : []
    const hol = (k) => a.find(x => x?.name === k)?.value || null
    const handle = hol('organisation')
    if (!handle) continue
    // Die Anschrift steht als MEHRERE `address`-Zeilen da — alle einsammeln.
    const anschrift = a.filter(x => x?.name === 'address').map(x => x.value).join(', ')
    raus.push({ handle, name: hol('org-name') || handle, address: anschrift || null })
  }
  return raus
}

/** `inetnum`-Objekte aus einer RIPE-Suchantwort. */
export function inetnumsFrom(ripeJson) {
  const raus = []
  for (const o of ripeJson?.objects?.object || []) {
    const a = Array.isArray(o?.attributes?.attribute) ? o.attributes.attribute : []
    const hol = (k) => a.find(x => x?.name === k)?.value || null
    const bereich = hol('inetnum') || hol('inet6num')
    if (bereich) raus.push({ bereich, netname: hol('netname') || null, status: hol('status') || null })
  }
  return raus
}

/**
 * Netzbereiche, die eine Organisation selbst hält — als Feld mit Herkunft.
 *
 * DER REGISTERNAME WIRD IMMER MITGEZEIGT. Der Abgleich zwischen dem Namen aus
 * der Karte („Autohaus Weber") und dem im Register („Weber Automobile GmbH")
 * ist eine Ähnlichkeit, keine Gewissheit. Wer beides nebeneinander liest, kann
 * selbst urteilen; wer nur das Ergebnis sähe, müsste glauben.
 *
 * @param {string} orgName
 * @param {object} io
 * @param {(name:string) => Promise<object|null>} io.findOrgs       RIPE-Suche, type-filter=organisation
 * @param {(handle:string) => Promise<object|null>} io.findInetnums RIPE-Suche, inverse-attribute=org
 * @param {string} [io.plz]      Postleitzahl der Anschrift, an der wir stehen
 * @param {string} [io.ort]      Ortsname, ersatzweise
 * @param {number} [io.max=6]   wie viele Bereiche genannt werden
 */
export async function ownRanges(orgName, io = {}) {
  const { findOrgs, findInetnums, plz = null, ort = null, max = 6 } = io
  if (!orgName || typeof findOrgs !== 'function' || typeof findInetnums !== 'function') return []
  // OHNE ORTSBEZUG WIRD NICHTS BEHAUPTET. Der Namensabgleich allein reicht
  // nicht — gemessen am 16.10.2026: „Heise Medien" traf `heise & dumrath
  // medien geschaeftsfuehrung gmbh`, weil beide zwei Wörter teilen. Ein
  // besserer Namensvergleich hätte den Fehler sogar bestärkt; was ihn
  // ausschliesst, ist die Anschrift, an der die Lupe gerade steht.
  if (!plz && !ort) return []

  let orgs
  try { orgs = orgHandles(await findOrgs(orgName)) } catch { return [] }
  const passtOrt = (o) => {
    const adr = String(o.address || '').toLowerCase()
    if (!adr) return false
    if (plz && adr.includes(String(plz).toLowerCase())) return true
    if (ort && adr.includes(String(ort).toLowerCase())) return true
    return false
  }
  const kandidaten = orgs.filter(o => namesMatch(o.name, orgName) && passtOrt(o))
  // MEHRERE PASSEN HEISST: NICHT ZUZUORDNEN. Schwestergesellschaften teilen
  // sich ein Haus (bei Heise sitzen zwei an derselben Anschrift). Eine davon
  // auszuwählen wäre geraten, und zwar unsichtbar.
  if (kandidaten.length !== 1) return []
  const treffer = kandidaten[0]

  let bereiche
  try { bereiche = inetnumsFrom(await findInetnums(treffer.handle)) } catch { return [] }
  // Nur, was die Organisation wirklich zugeteilt bekommen hat.
  const eigene = bereiche.filter(b => EIGEN_TYPEN.test(b.status || ''))
  if (!eigene.length) return []

  const liste = eigene.slice(0, max)
    .map(b => `${b.bereich}${b.netname ? ` (${b.netname})` : ''}`)
    .join(', ')
  const rest = eigene.length > liste.split(', ').length ? ` … insgesamt ${eigene.length}` : ''
  return [{
    feld: 'Eigene Netzbereiche',
    wert: `${liste}${rest}`,
    herkunft: `RIPE-Datenbank, eingetragen auf „${treffer.name}" (${treffer.handle})`,
  }]
}

/** Eine Registeranschrift in eine Zeile bringen. */
export const addressLine = (adr) =>
  String(adr || '').split('\n').map(s => s.trim()).filter(Boolean).join(', ')

/**
 * Die Netzspur einer Webseite, als Felder mit Herkunft.
 *
 * Alle Nachschlagewege werden hereingereicht — dadurch ist die ganze
 * Übersetzung ohne Netz prüfbar, und der Agent entscheidet selbst über
 * Zwischenspeicher und Kontingente.
 *
 * @param {string} webseite
 * @param {object} io
 * @param {(host:string) => Promise<string[]>} io.resolve4
 * @param {(host:string) => Promise<{exchange:string, priority:number}[]>} [io.resolveMx]
 * @param {(host:string) => Promise<string[]>} [io.resolveCname]
 * @param {(ip:string) => Promise<{name?:string, netname?:string, type?:string,
 *          handle?:string, address?:string}|null>} io.rdapOf
 * @param {string} [io.orgName]  Name des Betriebs — für den Fall „eigen"
 * @param {(ip:string) => Promise<object|null>} [io.shodanOf]
 *        Dienste-Abfrage. WIRD NUR IM FALL „EIGEN" AUFGERUFEN, und diese Regel
 *        steht absichtlich HIER und nicht beim Aufrufer: Bei einem gehosteten
 *        Auftritt beschriebe das Ergebnis die Maschine des Hosters, auf der
 *        tausend andere Kunden liegen — eine Aussage über Unbeteiligte. Beim
 *        CDN wäre es ein Netzknoten. Nur wenn die Organisation den Bereich
 *        nachweislich selbst hält, ist die Frage „was läuft dort" eine über sie.
 * @returns {Promise<{feld:string, wert:string, herkunft:string}[]>}
 */
export async function networkTrace(webseite, io = {}) {
  const host = hostFromUrl(webseite)
  if (!host) return []
  const { resolve4, resolveMx, resolveCname, rdapOf, shodanOf = null, orgName = null } = io
  if (typeof resolve4 !== 'function' || typeof rdapOf !== 'function') return []

  const felder = []
  const still = async (fn, ...a) => { try { return await fn(...a) } catch { return null } }

  const cnames = (await still(resolveCname, host)) || []
  const ips = (await still(resolve4, host)) || []
  if (!ips.length) {
    felder.push({ feld: 'Webseite', wert: `${host} — nicht auflösbar`, herkunft: 'DNS' })
    return felder
  }

  const owner = await still(rdapOf, ips[0])
  const cdn = detectCdn({ ownerName: owner?.name || owner?.netname || '', cnames })
  const fall = classify({ cdn, owner, orgName })

  if (fall === 'cdn') {
    // GENAU SO FORMULIERT, WIE ES GEMEINT IST: Die IP eines CDN-Knotens hat
    // keinen Aussagewert über einen Ort. Wer hier eine Anschrift zeigte,
    // behauptete, eine Bäckerei in Koblenz stünde in San Francisco.
    felder.push({
      feld: 'Webseite', wert: `${host} hinter ${cdn.name}`,
      herkunft: `DNS (${cdn.grund})`,
    })
  } else if (fall === 'eigen') {
    const wo = addressLine(owner.address)
    felder.push({
      feld: 'Eigener Netzbereich',
      wert: `${owner.handle || ips[0]}${owner.netname ? ` (${owner.netname})` : ''}`
        + ` — eingetragen auf ${owner.name}${wo ? `, ${wo}` : ''}`,
      herkunft: 'RIPE-Register (RDAP)',
    })
    // Nur hier: Die Maschine gehört nachweislich dieser Organisation.
    if (typeof shodanOf === 'function') {
      const dienste = shodanServices(await still(shodanOf, ips[0]))
      if (dienste) {
        felder.push({
          feld: 'Erreichbare Dienste', wert: dienste.text,
          herkunft: `Shodan${dienste.stand ? `, Stand ${dienste.stand}` : ''}`,
        })
      }
    }
  } else if (fall === 'verbraucher') {
    // Nicht verschweigen, aber auch nicht verorten: Die Registeranschrift wäre
    // hier die Konzernzentrale des Anbieters.
    felder.push({
      feld: 'Webseite', wert: `${host} — Anschluss eines Zugangsanbieters, nicht zuzuordnen`,
      herkunft: 'DNS + RIPE-Register',
    })
  } else {
    const wo = addressLine(owner?.address)
    felder.push({
      feld: 'Webserver', wert: `${host} → ${ips[0]} · ${owner?.name || owner?.netname || 'Inhaber unbekannt'}`
        + (wo ? ` (${wo})` : ''),
      herkunft: 'DNS + RIPE-Register (RDAP)',
    })
  }

  // E-Mail: dieselbe Frage, anderer Dienst. Oft verrät erst der MX, dass ein
  // Betrieb bei einem Grossanbieter liegt, während die Webseite woanders läuft.
  const mx = (await still(resolveMx, host)) || []
  if (mx.length) {
    const beste = [...mx].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0]
    const ziel = String(beste?.exchange || '').replace(/\.$/, '')
    if (ziel) {
      const mxCdn = detectCdn({ cnames: [ziel] })
      felder.push({
        feld: 'E-Mail-Server',
        wert: mxCdn ? `${ziel} (${mxCdn.name})` : ziel,
        herkunft: 'DNS (MX)',
      })
    }
  }
  return felder
}
