#!/usr/bin/env node
//
// tests/run-visuell.mjs — was man nur SIEHT.
//
//   npm run test:visuell          (Stack muss laufen: npm run stack)
//   AJNA_TEST_WEB=https://localhost AJNA_TEST_PB=http://127.0.0.1:8090 …
//   VISUELL_SICHTBAR=1            Browser mitlaufen lassen statt headless
//
// WARUM ES DIESE DATEI GIBT
//
// Am 2026-09-02 sind zwei Fehler gemeldet worden, die beide reine
// Darstellungsfehler waren:
//
//   • Die Minimap war in der 3D-Ansicht weg — ein `position:fixed`-Element
//     ohne einen einzigen Anker, das an seinen statischen Platz unter das
//     Fenster rutschte.
//   • Das Kontextmenü eines SmartHome-Objekts war höher als das Telefon; die
//     Einpassung rechnete eine negative Obergrenze aus und schob es nach oben
//     aus dem Bild.
//
// Beide wurden durch LESEN gefunden, nicht durch Hinsehen — das kostete viele
// Anläufe, und die üblichen Tests hätten sie nie gefangen: Sie prüfen die
// Rechnung und die Zustandsübergänge, nicht das Bild. „Liegt das Ding im
// sichtbaren Bereich?" ist keine Frage an den Quelltext.
//
// Hier läuft deshalb ein echter Browser im Telefonformat und misst, wo die
// Dinge liegen. Screenshots landen in tests/bilder/ — für den Menschen.
//
// BEWUSST NICHT: Pixelvergleiche. Ein Test, der bei jeder Farbänderung rot
// wird, wird abgeschaltet. Geprüft werden Aussagen, die falsch sein KÖNNEN:
// im Bild oder nicht, scrollbar oder nicht, übereinander oder nicht.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WEB = process.env.AJNA_TEST_WEB || 'https://localhost'
const PB = process.env.AJNA_TEST_PB || 'http://127.0.0.1:8090'
const PW = 'vtest-pw-12345'
const HIER = dirname(fileURLToPath(import.meta.url))
const BILDER = join(HIER, 'bilder')

// Fairphone 5, das Gerät auf dem entwickelt wird. Klein genug, dass zu grosse
// Fenster auffallen — genau darum geht es.
const TELEFON = { width: 412, height: 915 }

const ergebnisse = []
const check = (name, ok, info = '') => {
  ergebnisse.push({ name, ok: !!ok })
  console.log(`   ${ok ? '✅' : '❌'} ${name}${info ? ` — ${info}` : ''}`)
}

/** Liegt der Kasten vollständig im Fenster? */
const imBild = (k, v = TELEFON) =>
  !!k && k.x >= -1 && k.y >= -1 && k.x + k.width <= v.width + 1 && k.y + k.height <= v.height + 1

const beschreibe = (k) => k
  ? `x=${Math.round(k.x)} y=${Math.round(k.y)} ${Math.round(k.width)}×${Math.round(k.height)}`
  : 'nicht vorhanden'

async function api(pfad, opts = {}) {
  const r = await fetch(`${PB}${pfad}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

/** Wegwerf-Konto. Die Registrierung ist offen — kein Superuser nötig. */
async function konto() {
  const marke = Date.now().toString(36)
  const email = `vtest-${marke}@example.invalid`
  await api('/api/collections/users/records', {
    method: 'POST',
    body: { email, password: PW, passwordConfirm: PW, name: `Sichtprobe ${marke}` },
  })
  const r = await api('/api/collections/users/auth-with-password', {
    method: 'POST', body: { identity: email, password: PW },
  })
  if (!r.data?.token) throw new Error('Login fehlgeschlagen: ' + JSON.stringify(r.data))
  return { id: r.data.record.id, token: r.data.token, record: r.data.record, email }
}

/**
 * Angemeldet starten, ohne durch das Anmeldefenster zu klicken.
 *
 * Der Client führt seine Server in `ajna.servers.v1` und legt den Token unter
 * `ajna_auth_<serverId>` ab. Wir setzen beides mit einer FESTEN Kennung, bevor
 * die Seite lädt — sonst würfelt die Registry beim ersten Start eine neue aus
 * und wir wüssten den Schlüssel nicht.
 */
function anmeldeSkript(u, pbUrl) {
  return `
    const ID = 'vtest-server'
    localStorage.setItem('ajna.servers.v1', JSON.stringify({
      version: 1, defaultId: ID,
      servers: [{ id: ID, url: ${JSON.stringify(pbUrl)}, label: 'Sichtprobe', addedAt: Date.now() }],
    }))
    // Ältere und neuere SDK-Fassungen lesen 'model' bzw. 'record' — beides
    // hinzuschreiben ist billiger als die Version zu erraten.
    localStorage.setItem('ajna_auth_' + ID, JSON.stringify({
      token: ${JSON.stringify(u.token)},
      record: ${JSON.stringify(u.record)},
      model: ${JSON.stringify(u.record)},
    }))
    // Standort setzen, sonst steht die Karte irgendwo und die Testobjekte
    // liegen ausserhalb. Die Schluessel stehen in core/GPSProvider.js — sie
    // hier zu raten kostete einen Anlauf: Die Karte stand in Niederdorla.
    localStorage.setItem('ajna.gps.dummyMode', 'true')
    localStorage.setItem('ajna.gps.dummyPosition', JSON.stringify({ lat: 50.4466, lon: 7.5971 }))
    localStorage.setItem('ajna.gps.lastKnown', JSON.stringify({ lat: 50.4466, lon: 7.5971 }))
    // Ohne Standort-Freigabe meldet der Client nichts und sieht wenig.
    localStorage.setItem('ajna.privacy.default', 'exact')
  `
}

async function reiter(page, name) {
  await page.click(`.shell-tabbar button[data-tab="${name}"]`)
  await page.waitForTimeout(400)
}

async function lauf() {
  mkdirSync(BILDER, { recursive: true })
  const u = await konto()
  const browser = await chromium.launch({ headless: !process.env.VISUELL_SICHTBAR })
  const ctx = await browser.newContext({
    viewport: TELEFON, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true,   // Caddy nutzt lokal ein eigenes Zertifikat
  })
  const page = await ctx.newPage()
  const fehlerImLog = []
  page.on('pageerror', (e) => fehlerImLog.push(String(e?.message || e)))
  await page.addInitScript(anmeldeSkript(u, PB))
  await page.goto(WEB, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.shell-tabbar', { timeout: 20000 })
  await page.waitForTimeout(1500)

  console.log('\n── Grundgerüst')
  check('die Shell lädt und zeigt ihre Reiter',
    (await page.locator('.shell-tabbar button[data-tab]').count()) >= 3)
  check('ohne Fehler in der Konsole', fehlerImLog.length === 0, fehlerImLog[0] || '')

  // ── Minimap ────────────────────────────────────────────────────────────
  //
  // Der gemeldete Fehler in Reinform: erst in die Objektliste (dort dockt die
  // Karte oben an), dann zurück in die 3D-Ansicht. Danach war sie weg.
  console.log('\n── Minimap: liegt sie im Bild?')
  await reiter(page, 'ar')
  const fab = page.locator('.ajna-mm-fab')
  check('der Minimap-Knopf ist in der 3D-Ansicht da', await fab.isVisible(),
    beschreibe(await fab.boundingBox().catch(() => null)))

  // Aufklappen, falls zugeklappt — der Zustand überlebt Sitzungen.
  if (!(await page.locator('.ajna-mm-panel:not([hidden])').count())) await fab.click()
  await page.waitForTimeout(600)
  const panel = page.locator('.ajna-mm-panel')
  let k = await panel.boundingBox().catch(() => null)
  check('die Karte liegt vollständig im Fenster', imBild(k), beschreibe(k))
  await page.screenshot({ path: join(BILDER, '01-ar-minimap.png') })

  await reiter(page, 'nearby')
  k = await panel.boundingBox().catch(() => null)
  check('in der Objektliste dockt sie oben an', k && k.y < 120, beschreibe(k))
  const liste = await page.locator('.shell-view[data-view="nearby"]').boundingBox().catch(() => null)
  const padding = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.shell-view[data-view="nearby"]')).paddingTop)
  check('und die Liste beginnt darunter', parseFloat(padding) > 100, `padding-top: ${padding}`)
  await page.screenshot({ path: join(BILDER, '02-objekte-angedockt.png') })

  // DAS IST DIE PRÜFUNG, DIE HEUTE GEFEHLT HAT.
  await reiter(page, 'ar')
  k = await panel.boundingBox().catch(() => null)
  check('nach dem Abdocken ist sie WIEDER im Bild', imBild(k), beschreibe(k))
  await page.screenshot({ path: join(BILDER, '03-ar-nach-abdocken.png') })

  // ── Kontextmenü mit vielen Einträgen ───────────────────────────────────
  //
  // Ein SmartHome-Controller trägt eine Zeile pro Gerät. Hier ein Objekt mit
  // 40 Aktionen — mehr, als auf ein Telefon passt.
  console.log('\n── Kontextmenü: passt es auf das Telefon?')
  const viele = Array.from({ length: 40 }, (_, i) => ({ key: `a${i}`, label: `Gerät ${i} · light` }))
  await api('/api/collections/objects/records', {
    method: 'POST', token: u.token,
    body: {
      name: 'Sichtprobe Menue', type: 'item', lat: 50.4466, lon: 7.5971, altitude: 0,
      // Eigenes Zeichen, damit der Marker eindeutig zu finden ist. Ohne das
      // muesste man raten: Die Objekt-Kennung steht nicht im DOM.
      appearance: { emoji: '🧪' },
      state: { actions: viele, realtime: true },
    },
  })

  // Das Kontextmenue haengt an der KARTE (Klick auf den Marker), nicht an der
  // Objektliste — die zeigt Aktionen als eigene Knoepfe.
  await reiter(page, 'map')
  await page.waitForTimeout(2500)

  // GENAU EINEN Marker anklicken. Mehrere in einem Durchgang gingen schief:
  // Leaflet stellt Marker-Klicks auf Beruehr-Geraeten VERZOEGERT zu, und der
  // zuletzt geklickte gewann — das Menue stand kurz mit 44 Zeilen da und war
  // 400 ms spaeter durch ein fremdes mit 3 Zeilen ersetzt.
  const marker = page.locator('.leaflet-marker-icon', { hasText: '🧪' }).first()
  const gefunden = await marker.count()
  if (gefunden) {
    // ZUSTELLEN statt zielen: Am Testort liegen mehrere Objekte uebereinander
    // (ein UWB-Anker deckte es zu), und ein Klick auf Koordinaten trifft dann
    // den Nachbarn — im Screenshot gut zu sehen gewesen.
    await marker.dispatchEvent('click')
    await page.waitForTimeout(700)
  }
  check('der Marker des Testobjekts ist auf der Karte', gefunden > 0,
    `${await page.locator('.leaflet-marker-icon').count()} Marker gesamt`)

  const menue = page.locator('.ajna-context-menu')
  if (await menue.count()) {
    const mk = await menue.boundingBox()
    check('das Menü liegt im Fenster', imBild(mk), beschreibe(mk))
    const scrollbar = await page.evaluate(() => {
      const b = document.querySelector('.ajna-context-menu .ctx-body')
      return b ? b.scrollHeight > b.clientHeight + 2 : false
    })
    check('und sein Inhalt scrollt', scrollbar)
    check('bei vielen Einträgen gibt es ein Suchfeld',
      (await page.locator('.ajna-context-menu .ctx-filter input').count()) === 1)
    await page.screenshot({ path: join(BILDER, '04-kontextmenue.png') })
  } else {
    check('das Kontextmenü liess sich öffnen', false, 'kein Menü erschienen')
  }

  // ── Auftrags-Formular ──────────────────────────────────────────────────
  console.log('\n── Auftrags-Formular')
  await page.evaluate(() => document.querySelector('.ajna-quest-launcher')?.click())
  await page.waitForTimeout(800)
  const qp = page.locator('.ajna-quest')
  if (await qp.count()) {
    const qk = await qp.boundingBox()
    check('das Auftragsfenster passt ins Bild', imBild(qk), beschreibe(qk))
    await page.screenshot({ path: join(BILDER, '05-auftraege.png') })
  }

  await browser.close()

  const schlecht = ergebnisse.filter(r => !r.ok)
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Sichtprobe: ${ergebnisse.length - schlecht.length} bestanden, ${schlecht.length} fehlgeschlagen`)
  console.log(`Bilder in ${BILDER}`)
  if (schlecht.length) {
    console.log('\nFehlgeschlagen:')
    for (const f of schlecht) console.log('  ❌ ' + f.name)
    process.exit(1)
  }
  console.log('✅ alles grün')
}

lauf().catch(err => {
  console.error('\n❌ Sichtprobe abgebrochen:', err?.message || err)
  console.error('   Läuft der Stack? (npm run stack) — erwartet wird', WEB, 'und', PB)
  process.exit(1)
})
