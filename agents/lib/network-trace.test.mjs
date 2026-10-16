// Tests für agents/lib/network-trace.mjs.
//
// HERKUNFT DER TESTDATEN: Alle RDAP- und DNS-Vektoren unten sind am 16.10.2026
// von den echten Diensten geholt (RIPE RDAP, öffentliches DNS) und gekürzt.
// Erfundene Datensätze hätten genau die Felder, die man erwartet — und keine
// der beiden Fallen, über die ich dabei gestolpert bin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  networkTrace, ownerFromRdap, detectCdn, classify, hostFromUrl, aehnlich, anschriftZeile, shodanServices,
} from './network-trace.mjs'

// ─── ECHTE RDAP-Antwort: heise.de ────────────────────────────────────────
// Gekürzt auf die Einträge; die Reihenfolge ist die des Servers.
const RDAP_HEISE = {
  handle: '193.99.144.0 - 193.99.144.255', name: 'HEISE-NET', type: 'ASSIGNED PI',
  entities: [
    { handle: 'AS20016-RIPE', roles: ['administrative'], vcardArray: ['vcard', [
      ['kind', {}, 'text', 'individual'], ['fn', {}, 'text', 'Alfons Schraeder'],
      ['adr', { label: 'Heise Medien GmbH & Co. KG\nKarl-Wiechert-Allee 10\n30625 Hannover\nGermany' }, 'text', []]]] },
    { handle: 'IPH-MNT', roles: ['registrant'], vcardArray: ['vcard', [
      ['kind', {}, 'text', 'individual'], ['fn', {}, 'text', 'IPH-MNT']]] },
    { handle: 'ORG-HGGC1-RIPE', roles: ['registrant'], vcardArray: ['vcard', [
      ['kind', {}, 'text', 'org'], ['fn', {}, 'text', 'Heise Gruppe GmbH & Co. KG'],
      ['adr', { label: 'Karl-Wiechert-Allee 10\n30625 Hannover\nDE' }, 'text', []]]] },
    { handle: 'PLUSLINE-MNT', roles: ['registrant'], vcardArray: ['vcard', [
      ['kind', {}, 'text', 'individual'], ['fn', {}, 'text', 'PLUSLINE-MNT']]] },
  ],
}

const RDAP_STRATO = {
  handle: '81.169.144.0 - 81.169.148.255', name: 'STRATO-RZG-KA', type: 'ASSIGNED PA',
  entities: [{ handle: 'ORG-SA1-RIPE', roles: ['registrant'], vcardArray: ['vcard', [
    ['kind', {}, 'text', 'org'], ['fn', {}, 'text', 'Strato GmbH'],
    ['adr', { label: 'Otto-Ostrowski-Straße 7\n10249\nBerlin\nGERMANY' }, 'text', []]]] }],
}

const RDAP_CLOUDFLARE = {
  handle: 'NET-162-158-0-0-1', name: 'CLOUDFLARENET', type: 'DIRECT ALLOCATION',
  entities: [{ handle: 'CLOUD14', roles: ['registrant'], vcardArray: ['vcard', [
    ['kind', {}, 'text', 'org'], ['fn', {}, 'text', 'Cloudflare, Inc.'],
    ['adr', { label: '101 Townsend Street\nSan Francisco\nCA\n94107\nUnited States' }, 'text', []]]] }],
}

// Koblenz: NUR ein Maintainer, keine Organisation — der ehrliche Leerfall.
const RDAP_NETCLUSIVE = {
  handle: '89.110.133.0 - 89.110.133.255', name: 'NCL-NET', type: 'ASSIGNED PA',
  entities: [{ handle: 'NETCLUSIVE-MNT', roles: ['registrant'], vcardArray: ['vcard', [
    ['kind', {}, 'text', 'individual'], ['fn', {}, 'text', 'NETCLUSIVE-MNT']]] }],
}

// ─── Inhaber aus RDAP ────────────────────────────────────────────────────

test('[ECHT] Wartungs-Handles gelten nicht als Inhaber', () => {
  // FALLE 1: Vier Einträge tragen `registrant`, drei davon sind Maintainer.
  // Wer den ersten nimmt, schreibt „eingetragen auf IPH-MNT".
  const o = ownerFromRdap(RDAP_HEISE)
  assert.equal(o.name, 'Heise Gruppe GmbH & Co. KG')
  assert.match(o.address, /Karl-Wiechert-Allee 10/)
  assert.equal(o.netname, 'HEISE-NET')
  assert.equal(o.type, 'ASSIGNED PI')
})

test('[ECHT] der administrative Kontakt ist ein MENSCH und bleibt draussen', () => {
  // FALLE 2: „Alfons Schraeder", kind `individual`, mit vollständiger
  // Anschrift. Er steht im Register, weil jemand erreichbar sein muss — nicht,
  // damit ein Spiel ihn anzeigt.
  const o = ownerFromRdap(RDAP_HEISE)
  assert.ok(!JSON.stringify(o).includes('Schraeder'), JSON.stringify(o))
})

test('[ECHT] ohne Organisation bleibt der Inhaber leer, statt geraten zu werden', () => {
  const o = ownerFromRdap(RDAP_NETCLUSIVE)
  assert.equal(o.name, null, 'ein Maintainer-Handle ist kein Inhaber')
  assert.equal(o.netname, 'NCL-NET', 'der Netzname bleibt — er ist eine Tatsache')
})

test('kaputte Antworten kippen nichts um', () => {
  assert.equal(ownerFromRdap(null), null)
  assert.deepEqual(ownerFromRdap({}), { name: null, address: null, netname: null, type: null, handle: null })
  assert.equal(ownerFromRdap({ entities: [{ vcardArray: 'müll' }] }).name, null)
})

// ─── CDN erkennen ────────────────────────────────────────────────────────

test('[ECHT] Cloudflare ohne CNAME wird am Registernamen erkannt', () => {
  // Der gemessene Fall: www.bangkokthairestaurantkoblenz.de löst DIREKT auf
  // 162.159.128.70 auf, ohne CNAME. Nur der Inhaber verrät das CDN.
  const t = detectCdn({ ownerName: 'Cloudflare, Inc.', cnames: [] })
  assert.equal(t.name, 'Cloudflare')
  assert.match(t.grund, /Netzbereich/)
})

test('ein CNAME wiegt schwerer als der Registername', () => {
  // Der CNAME sagt, wohin der Betrieb SELBST zeigt; der Registername der IP
  // kann auch ein Wiederverkäufer sein.
  const t = detectCdn({ ownerName: 'Irgendein Hoster', cnames: ['x.cdn.cloudflare.net'] })
  assert.equal(t.name, 'Cloudflare')
  assert.match(t.grund, /CNAME/)
})

test('gewöhnliche Hoster sind kein CDN', () => {
  assert.equal(detectCdn({ ownerName: 'Strato GmbH', cnames: ['ding-dong.com'] }), null)
  assert.equal(detectCdn({}), null)
})

// ─── Die drei Fälle ──────────────────────────────────────────────────────

test('eigener Netzbereich wird nur bei PASSENDEM Namen angenommen', () => {
  const heise = ownerFromRdap(RDAP_HEISE)
  assert.equal(classify({ owner: heise, orgName: 'Heise Medien' }), 'eigen')
  // OHNE Namensabgleich wäre jeder Hosting-Block „eigen" — und die angezeigte
  // Anschrift die des Hosters.
  assert.equal(classify({ owner: heise, orgName: 'Bäckerei Schmitt' }), 'gehostet')
  assert.equal(classify({ owner: heise, orgName: null }), 'gehostet')
})

test('ein Hoster bleibt ein Hoster', () => {
  assert.equal(classify({ owner: ownerFromRdap(RDAP_STRATO), orgName: 'Adria Balkan Bäckerei' }), 'gehostet')
})

test('ein CDN schlägt alles andere', () => {
  assert.equal(classify({ cdn: { name: 'Cloudflare' }, owner: ownerFromRdap(RDAP_CLOUDFLARE) }), 'cdn')
})

test('Zugangsnetze werden am Netznamen erkannt und nicht verortet', () => {
  for (const netname of ['DTAG-DIAL21', 'KABELBW-CUSTOMER-NET', 'VODAFONE-DE-POOL3', 'TELEFONICA-DSL']) {
    assert.equal(classify({ owner: { netname, name: 'Irgendwer' } }), 'verbraucher', netname)
  }
  assert.notEqual(classify({ owner: { netname: 'HEISE-NET' } }), 'verbraucher')
})

test('Namensabgleich ignoriert Rechtsformen und Allerweltswörter', () => {
  assert.equal(aehnlich('Heise Gruppe GmbH & Co. KG', 'Heise Medien'), true)
  assert.equal(aehnlich('Müller GmbH', 'Schmitt GmbH'), false, 'GmbH allein zählt nicht')
  assert.equal(aehnlich('Stadtwerke Koblenz GmbH', 'Stadtwerke Koblenz'), true)
  assert.equal(aehnlich('', 'Heise'), false)
})

// ─── Ganze Spur ──────────────────────────────────────────────────────────

const io = ({ a = [], cname = [], mx = [], rdap = null, orgName = null }) => ({
  resolve4: async () => a,
  resolveCname: async () => cname,
  resolveMx: async () => mx,
  rdapOf: async () => (rdap ? ownerFromRdap(rdap) : null),
  orgName,
})

test('[ECHT] Fall „gehostet": Bäckerei bei Strato', async () => {
  const f = await networkTrace('www.ding-dong.com', io({
    a: ['81.169.145.149'], cname: ['ding-dong.com'],
    mx: [{ exchange: 'smtpin.rzone.de', priority: 5 }],
    rdap: RDAP_STRATO, orgName: 'Adria Balkan Bäckerei & Pizza',
  }))
  const web = f.find(x => x.feld === 'Webserver')
  assert.ok(web, JSON.stringify(f))
  assert.match(web.wert, /81\.169\.145\.149/)
  assert.match(web.wert, /Strato GmbH/)
  assert.match(web.wert, /Otto-Ostrowski-Straße 7, 10249, Berlin/)
  assert.match(web.herkunft, /RDAP/)
  assert.equal(f.find(x => x.feld === 'E-Mail-Server')?.wert, 'smtpin.rzone.de')
})

test('[ECHT] Fall „hinter einem CDN": kein Ort wird behauptet', async () => {
  // Die Anschrift von Cloudflare ist San Francisco. Sie hier zu zeigen hiesse,
  // ein Restaurant in Koblenz stünde in Kalifornien.
  const f = await networkTrace('www.bangkokthairestaurantkoblenz.de', io({
    a: ['162.159.128.70'], rdap: RDAP_CLOUDFLARE, orgName: 'Bangkok',
  }))
  const web = f.find(x => x.feld === 'Webseite')
  assert.equal(web.wert, 'www.bangkokthairestaurantkoblenz.de hinter Cloudflare')
  assert.ok(!JSON.stringify(f).includes('San Francisco'), JSON.stringify(f))
  assert.ok(!JSON.stringify(f).includes('Townsend'))
})

test('[ECHT] Fall „eigen": Organisation hält den Bereich selbst', async () => {
  const f = await networkTrace('www.heise.de', io({
    a: ['193.99.144.85'],
    mx: [{ exchange: 'mx01.hornetsecurity.com', priority: 10 },
         { exchange: 'mx02.hornetsecurity.com', priority: 20 }],
    rdap: RDAP_HEISE, orgName: 'Heise Medien',
  }))
  const eigen = f.find(x => x.feld === 'Eigener Netzbereich')
  assert.ok(eigen, JSON.stringify(f))
  assert.match(eigen.wert, /HEISE-NET/)
  assert.match(eigen.wert, /Heise Gruppe GmbH/)
  assert.match(eigen.wert, /Karl-Wiechert-Allee 10/)
  // Der MX mit der KLEINSTEN Priorität ist der zuständige.
  assert.equal(f.find(x => x.feld === 'E-Mail-Server').wert, 'mx01.hornetsecurity.com')
})

test('eine nicht auflösbare Webseite wird als solche gemeldet', async () => {
  const f = await networkTrace('www.gibtsnicht.invalid', io({ a: [] }))
  assert.match(f[0].wert, /nicht auflösbar/)
})

test('ohne brauchbare Eingabe passiert nichts', async () => {
  assert.deepEqual(await networkTrace('', io({})), [])
  assert.deepEqual(await networkTrace('kein url', {}), [], 'ohne Nachschlagewege')
  assert.equal(hostFromUrl('ht!tp://%%%'), null)
})

test('jedes Feld trägt seine Herkunft', async () => {
  // Dritte Regel der Lupe: Der Betrachter soll sehen, DASS jedes Stück offen
  // herumlag — nicht nur, was zusammenkommt.
  const f = await networkTrace('www.ding-dong.com', io({
    a: ['81.169.145.149'], mx: [{ exchange: 'smtpin.rzone.de', priority: 5 }], rdap: RDAP_STRATO,
  }))
  assert.ok(f.length > 0)
  for (const x of f) assert.ok(x.herkunft && x.herkunft.length > 3, JSON.stringify(x))
})

test('Anschriften werden zu einer Zeile, ohne leere Stücke', () => {
  assert.equal(anschriftZeile('A\n\nB\n C '), 'A, B, C')
  assert.equal(anschriftZeile(null), '')
})

test('ein Hostname muss wie ein Name aussehen', () => {
  // `new URL()` ist grosszügig: Aus „ht!tp://%%%" wird klaglos „ht!tp". OSM-
  // Einträge sind von Hand gepflegt, und Unsinn steht dort regelmässig —
  // ohne diese Prüfung ginge darauf eine DNS-Anfrage.
  assert.equal(hostFromUrl('ht!tp://%%%'), null)
  assert.equal(hostFromUrl('localhost'), null, 'ohne Punkt ist es kein Name')
  assert.equal(hostFromUrl('nur text mit leerzeichen'), null)
  assert.equal(hostFromUrl('https://www.beispiel.de/pfad?x=1'), 'www.beispiel.de')
  assert.equal(hostFromUrl('beispiel.de'), 'beispiel.de')
  assert.equal(hostFromUrl('WWW.Beispiel.DE.'), 'www.beispiel.de', 'kleingeschrieben, Punkt weg')
})

// ─── Shodan: Dienste, aber nur wo es die eigene Maschine ist ─────────────

// Aufbau einer echten /shodan/host/{ip}-Antwort, gekürzt.
const SHODAN = {
  ip_str: '193.99.144.85', ports: [80, 443, 22],
  data: [
    { port: 443, transport: 'tcp', product: 'nginx', version: '1.24.0', timestamp: '2026-10-02T11:04:12.000' },
    { port: 443, transport: 'tcp', timestamp: '2026-09-28T08:00:00.000' },   // zweite Aufnahme, ohne Produkt
    { port: 80, transport: 'tcp', product: 'nginx', timestamp: '2026-10-01T06:12:00.000' },
  ],
  vulns: ['CVE-2023-44487', 'CVE-2024-1234'],
}

test('Dienste werden je Port verdichtet, der beste Eintrag gewinnt', () => {
  const d = shodanServices(SHODAN)
  assert.equal(d.text, '22, 80 (nginx), 443 (nginx 1.24.0)')
  assert.equal(d.anzahl, 3, 'Port 22 steht nur in `ports`, nicht in `data`')
  assert.equal(d.stand, '2026-10-02')
})

test('die Schwachstellenliste bleibt draussen', () => {
  // BEWUSSTE ENTSCHEIDUNG: Offene Ports und erkannte Dienste zeigen
  // vollständig, wie viel offen herumliegt. Eine CVE-Liste fügt dieser
  // Einsicht nichts hinzu und macht aus einer Vorführung eine Zielliste.
  const d = shodanServices(SHODAN)
  assert.ok(!JSON.stringify(d).includes('CVE'), JSON.stringify(d))
})

test('ohne Dienste gibt es kein Feld', () => {
  assert.equal(shodanServices({ ip_str: 'x' }), null)
  assert.equal(shodanServices(null), null)
  assert.equal(shodanServices({ data: [{ port: 'keine Zahl' }] }), null)
})

test('[Regel] Shodan wird NUR bei eigenem Netzbereich gefragt', async () => {
  // Die wichtigste Zeile dieser Datei. Bei einem gehosteten Auftritt beschriebe
  // das Ergebnis die Maschine des Hosters, auf der tausend andere Kunden
  // liegen — eine Aussage über Unbeteiligte. Beim CDN wäre es ein Netzknoten.
  const gefragt = []
  const mitShodan = (opts) => ({ ...io(opts), shodanOf: async (ip) => { gefragt.push(ip); return SHODAN } })

  await networkTrace('www.ding-dong.com', mitShodan({
    a: ['81.169.145.149'], rdap: RDAP_STRATO, orgName: 'Adria Balkan Bäckerei' }))
  assert.deepEqual(gefragt, [], 'gehostet: nicht fragen')

  await networkTrace('www.bangkokthairestaurantkoblenz.de', mitShodan({
    a: ['162.159.128.70'], rdap: RDAP_CLOUDFLARE, orgName: 'Bangkok' }))
  assert.deepEqual(gefragt, [], 'CDN: nicht fragen')

  await networkTrace('x.de', mitShodan({
    a: ['1.2.3.4'], rdap: { name: 'DTAG-DIAL21', entities: [] }, orgName: 'Irgendwer' }))
  assert.deepEqual(gefragt, [], 'Zugangsnetz: nicht fragen')

  const f = await networkTrace('www.heise.de', mitShodan({
    a: ['193.99.144.85'], rdap: RDAP_HEISE, orgName: 'Heise Medien' }))
  assert.deepEqual(gefragt, ['193.99.144.85'], 'eigen: fragen')
  const dienste = f.find(x => x.feld === 'Erreichbare Dienste')
  assert.ok(dienste, JSON.stringify(f))
  assert.match(dienste.wert, /443 \(nginx 1\.24\.0\)/)
  assert.match(dienste.herkunft, /^Shodan, Stand 2026-10-02$/)
})

test('ohne Shodan-Zugang läuft die Spur trotzdem durch', async () => {
  const f = await networkTrace('www.heise.de', io({
    a: ['193.99.144.85'], rdap: RDAP_HEISE, orgName: 'Heise Medien' }))
  assert.ok(f.find(x => x.feld === 'Eigener Netzbereich'))
  assert.ok(!f.find(x => x.feld === 'Erreichbare Dienste'))
})

test('ein Fehler bei Shodan kippt die Spur nicht', async () => {
  const f = await networkTrace('www.heise.de', {
    ...io({ a: ['193.99.144.85'], rdap: RDAP_HEISE, orgName: 'Heise Medien' }),
    shodanOf: async () => { throw new Error('403 Membership required') },
  })
  assert.ok(f.find(x => x.feld === 'Eigener Netzbereich'), 'der Rest muss bleiben')
})
