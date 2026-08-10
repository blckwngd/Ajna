// Interaktiver Setup-Wizard für das Home-Assistant-Gateway.
//
// Läuft beim ERSTEN Start des Gateways (fehlende Pflichtwerte) oder explizit
// via `--setup` (dann mit den bisherigen Werten vorbelegt). Schreibt die
// agent-eigene Datei agents/.env.ha-gateway (siehe lib/env.mjs — Root-.env
// bleibt globaler Fallback) und setzt die Werte zugleich in process.env, damit
// das Gateway direkt weiterstarten kann.
//
// Schritte: Ajna-Instanz (lokal erkennen / extern eingeben) → Gateway-User
// (vorhanden oder per Superuser anlegen, inkl. default_permissions) → MQTT
// (Instanz-Namespace, HA-Zugangsdaten, Port) → TLS (Caddy-Zertifikat
// mitbenutzen / selbstsigniert / eigene Pfade) → Controller-Koordinaten →
// .env schreiben → HA-Anleitung generieren → optional pm2-Registrierung.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import PocketBase from 'pocketbase'
import { writeAgentEnv, agentEnvPath } from './env.mjs'
import {
  makeRl, ask, askHidden, confirm, choose, randomSecret, httpGet,
  probeLocalAjna, caddyDomains, findCaddyCert, pm2Available, pm2Register,
  pm2Processes, pm2Restart, REPO_ROOT,
  C, banner, header, hint, ok, warnLine, failLine, infoLine,
} from './setup-wizard.mjs'

const AGENT = 'ha-gateway'

export async function runHaSetup() {
  const rl = makeRl()
  const env = process.env
  banner('Ajna · Home-Assistant-Gateway — Einrichtung',
    '6 Schritte. Enter übernimmt den [Vorschlag]; Passwörter bleiben bei der Eingabe unsichtbar. Abbruch jederzeit mit Strg+C.')

  // ── 1) Ajna-Instanz ────────────────────────────────────────────────────
  // AJNA_URL aus der geschichteten .env wird als erster Kandidat mitgeprobt —
  // hinter Caddy (VPS) greifen die Standard-Ports nicht, die .env kennt die URL.
  header('Schritt 1/6 · Ajna-Instanz')
  let ajnaUrl = (env.AJNA_URL || '').replace(/\/+$/, '')
  console.log(`${C.dim}   Suche laufende Instanzen …${C.reset}`)
  const local = (await probeLocalAjna([ajnaUrl])).filter(f => f.isAjna)
  const srcLabel = { env: 'aus .env', caddy: 'via Caddyfile', default: 'lokal erkannt' }
  const options = [
    ...local.map(f => `${f.url}  ${C.dim}(${srcLabel[f.source] || 'erkannt'})${C.reset}`),
    'Andere Instanz (URL eingeben)',
  ]
  const defIdx = ajnaUrl && !local.some(f => f.url === ajnaUrl) ? options.length - 1
    : Math.max(0, local.findIndex(f => f.url === ajnaUrl))
  if (!local.length) hint('Keine laufende Instanz gefunden (geprüft: AJNA_URL aus .env, Caddyfile-Domains, Standard-Ports).')
  const pick = await choose(rl, 'Welche Ajna-Instanz soll das Gateway nutzen?', options, defIdx)
  if (pick < local.length) ajnaUrl = local[pick].url
  else {
    ajnaUrl = await ask(rl, 'Ajna-URL', ajnaUrl || 'https://ajna.example.org')
    const h = await httpGet(`${ajnaUrl}/api/health`, { insecure: true })
    if (!h || h.status !== 200) warnLine(`Instanz antwortet nicht auf /api/health (${h?.error || `HTTP ${h?.status}`}) — bitte URL prüfen (weiter trotzdem möglich).`)
    else ok('Instanz erreichbar.')
  }

  // ── 2) Gateway-User ────────────────────────────────────────────────────
  header('Schritt 2/6 · Gateway-Benutzer')
  hint('Der Ajna-Account, unter dem das Gateway seine Objekte anlegt und pflegt.')
  let ajnaUser = env.AJNA_USER || '', ajnaPass = env.AJNA_PASS || ''
  const userMode = await choose(rl, 'Benutzer für das Gateway:', [
    `Neu anlegen  ${C.dim}(Superuser-Zugang nötig; Passwort wird generiert)${C.reset}`,
    'Vorhandenen Benutzer verwenden',
  ], ajnaUser ? 1 : 0)
  const pb = new PocketBase(ajnaUrl)
  let suActive = false   // Superuser-Session aktiv? (transient, wird nie gespeichert)
  if (userMode === 0) {
    hint('Der Superuser-Zugang wird nur für diesen Schritt genutzt und nirgends gespeichert.')
    const suEmail = await ask(rl, 'Superuser-E-Mail')
    const suPass = await askHidden(rl, 'Superuser-Passwort')
    try {
      await pb.collection('_superusers').authWithPassword(suEmail, suPass)
      suActive = true
      ok('Superuser-Login ok.')
    } catch (e) { failLine(`Superuser-Login fehlgeschlagen: ${e?.message || e}`); rl.close(); return { exit: true } }
    ajnaUser = await ask(rl, 'E-Mail des neuen Gateway-Users', ajnaUser || 'ha-gateway@ajna.local')
    ajnaPass = randomSecret()
    // Sichtbarkeit der angelegten Geräte: default_permissions des Users werden
    // beim Object-Create als ACEs materialisiert (pb_hooks applyOwnerDefaults).
    const aud = await choose(rl, 'Wer darf die HA-Geräte standardmäßig sehen und schalten?', [
      `Angemeldete Nutzer  ${C.dim}(empfohlen)${C.reset}`,
      'Alle, auch anonym',
      'Niemand — Rechte später manuell vergeben',
    ], 0)
    // Gültige rights: view/edit/move/owner — Interaktion läuft NICHT über ein
    // "interact"-Recht, sondern ausschließlich über interact_actions (Schema +
    // canInteract in pb_hooks/permissions.js).
    const defaults = aud === 2 ? [] : [{
      subject_type: aud === 1 ? 'everyone' : 'authenticated', subject: '',
      rights: ['view'], interact_actions: ['*'],
    }]
    try {
      await pb.collection('users').create({
        email: ajnaUser, password: ajnaPass, passwordConfirm: ajnaPass,
        verified: true, name: 'HA-Gateway', default_permissions: defaults,
      })
      ok(`Benutzer ${ajnaUser} angelegt (Passwort generiert).`)
    } catch (e) {
      failLine(`Benutzer-Anlage fehlgeschlagen: ${e?.response?.message || e?.message || e}`)
      rl.close(); return { exit: true }
    }
  } else {
    ajnaUser = await ask(rl, 'Gateway-User (E-Mail)', ajnaUser)
    hint(ajnaPass ? 'Enter behält das bereits gespeicherte Passwort.' : '')
    ajnaPass = (await askHidden(rl, 'Passwort')) || ajnaPass
  }

  // ── 3) Admin-Spieler (optional) ────────────────────────────────────────
  // Bekommt vom Gateway auf dem Controller und ALLEN Geräte-Objekten eine
  // User-ACE mit view/edit/move/owner + allen Aktionen — de facto Besitzer.
  // Das owner-FELD bleibt beim Gateway-User (der muss seine Objekte pflegen);
  // das owner-RECHT greift über die PB-Regeln (Migration owner_right_in_rules).
  header('Schritt 3/6 · Admin-Spieler (optional)')
  hint('Dieser Spieler-Account erhält Vollzugriff auf Controller + Geräte-Objekte (verschieben, bearbeiten, Rechte verwalten) — de facto Besitzer.')
  let adminUser = env.HA_ADMIN_USER || ''
  {
    const input = (await ask(rl, 'Admin-Spieler (User-ID/E-Mail, leer = keiner)', adminUser)).trim()
    if (!input) adminUser = ''
    else if (!input.includes('@')) adminUser = input
    else {
      // E-Mail → ID braucht Superuser-Rechte (users sind für normale Accounts
      // nicht listbar). Session aus Schritt 2 wird mitbenutzt, sonst nachfragen.
      if (!suActive) {
        hint('Die E-Mail-Auflösung braucht einmalig Superuser-Zugang (leer lassen → stattdessen User-ID eingeben).')
        const suEmail = await ask(rl, 'Superuser-E-Mail')
        if (suEmail) {
          const suPass = await askHidden(rl, 'Superuser-Passwort')
          try { await pb.collection('_superusers').authWithPassword(suEmail, suPass); suActive = true }
          catch (e) { failLine(`Superuser-Login fehlgeschlagen: ${e?.message || e}`) }
        }
      }
      if (suActive) {
        try {
          const u = await pb.collection('users').getFirstListItem(`email = ${JSON.stringify(input)}`)
          adminUser = u.id
          ok(`${input} → User-ID ${u.id}`)
        } catch {
          warnLine(`Kein Nutzer mit E-Mail ${input} gefunden.`)
          adminUser = (await ask(rl, 'User-ID (leer = keiner)', '')).trim()
        }
      } else {
        warnLine('Ohne Superuser keine E-Mail-Auflösung — die User-ID steht in PB-Admin → users.')
        adminUser = (await ask(rl, 'User-ID (leer = keiner)', '')).trim()
      }
    }
  }
  pb.authStore.clear()   // Superuser-Session verwerfen

  try {
    await pb.collection('users').authWithPassword(ajnaUser, ajnaPass)
    ok('Gateway-Login geprüft.')
    pb.authStore.clear()
  } catch (e) { warnLine(`Gateway-Login fehlgeschlagen (${e?.message || e}) — Werte werden trotzdem gespeichert.`) }

  // ── 4) MQTT ────────────────────────────────────────────────────────────
  header('Schritt 4/6 · MQTT-Broker')
  hint('Das Gateway bringt einen eigenen Broker mit; Home Assistant verbindet sich ausgehend dorthin. Der Namespace trennt mehrere HA-Instanzen.')
  const haInstance = (await ask(rl, 'Namespace dieser HA-Instanz', env.HA_INSTANCE || 'home')).replace(/[^a-z0-9_-]/gi, '')
  const mqttHaUser = await ask(rl, 'MQTT-Benutzername für den HA-Client', env.MQTT_HA_USER || `ha_${haInstance}`)
  const mqttHaPass = env.MQTT_HA_PASS && await confirm(rl, 'Vorhandenes MQTT-Passwort behalten?', true)
    ? env.MQTT_HA_PASS : randomSecret()

  // ── 5) TLS (mit Caddy-Bewusstsein) ─────────────────────────────────────
  header('Schritt 5/6 · Verschlüsselung (TLS)')
  hint('MQTT läuft als rohes TCP direkt zum Broker — nicht über Caddy. Für öffentlich erreichbare Broker unbedingt TLS aktivieren.')
  let tls = { cert: env.MQTT_TLS_CERT || '', key: env.MQTT_TLS_KEY || '', auto: /^(1|true)$/i.test(env.MQTT_TLS_AUTO || ''), san: env.MQTT_TLS_SAN || '' }
  const cad = caddyDomains()
  const tlsOpts = []
  const caddyCerts = []
  for (const d of cad.domains) {
    const c = findCaddyCert(d)
    if (c) { caddyCerts.push({ domain: d, ...c }); tlsOpts.push(`Caddy-Zertifikat mitbenutzen: ${d}${c.readable ? '' : ` ${C.yellow}(aktuell NICHT lesbar)${C.reset}`}`) }
  }
  tlsOpts.push(`Selbstsigniert  ${C.dim}(Gateway erzeugt eines; Fingerprint fürs HA-Pinning)${C.reset}`)
  tlsOpts.push('Eigene Zertifikat-Pfade angeben')
  tlsOpts.push(`Kein TLS  ${C.dim}(nur LAN/Test — unverschlüsselt!)${C.reset}`)
  const tlsPick = await choose(rl, 'TLS für den MQTT-Broker:', tlsOpts, tls.cert ? tlsOpts.length - 2 : (caddyCerts.length ? 0 : tlsOpts.length - 3))
  let tlsMode
  if (tlsPick < caddyCerts.length) {
    const c = caddyCerts[tlsPick]
    tlsMode = 'caddy'; tls = { cert: c.crt, key: c.key, auto: false, san: '' }
    if (!c.readable) warnLine('Zertifikat/Key sind für diesen Benutzer nicht lesbar — Leserechte gewähren (z. B. Gateway als selber Benutzer wie Caddy laufen lassen).')
    infoLine('Caddy erneuert das Zertifikat automatisch (~60–90 Tage) — danach Gateway neu starten (pm2 restart).')
  } else if (tlsPick === caddyCerts.length) {
    tlsMode = 'auto'
    hint('Der Name kommt ins Zertifikat (SAN) — der Hostname oder die IP, unter der Home Assistant den Broker erreicht.')
    const san = await ask(rl, 'Hostname/IP für das Zertifikat', tls.san || cad.domains[0] || '')
    tls = { cert: '', key: '', auto: true, san }
  } else if (tlsPick === caddyCerts.length + 1) {
    tlsMode = 'manual'
    tls.cert = await ask(rl, 'Pfad Zertifikat (PEM)', tls.cert)
    tls.key = await ask(rl, 'Pfad Private Key (PEM)', tls.key)
    tls.auto = false
  } else { tlsMode = 'none'; tls = { cert: '', key: '', auto: false, san: '' } }
  const mqttPort = parseInt(await ask(rl, 'MQTT-Broker-Port', env.MQTT_PORT || (tlsMode === 'none' ? '1883' : '8883')), 10)
  infoLine(`Firewall: Port ${mqttPort}/tcp eingehend öffnen — MQTT läuft NICHT über Caddy.`)

  // ── 6) Controller-Koordinaten ──────────────────────────────────────────
  header('Schritt 6/6 · Standort')
  hint('Hier erscheint das Smart-Home-Controller-Objekt in der Spielwelt. Grob reicht — später per Karte/Editor exakt schieben.')
  const haLat = await ask(rl, 'Breitengrad (lat)', env.HA_LAT || '50.3569')
  const haLon = await ask(rl, 'Längengrad (lon)', env.HA_LON || '7.5890')

  // ── Schreiben + HA-Anleitung ───────────────────────────────────────────
  header('Fertig')
  const envPath = writeAgentEnv(AGENT, {
    AJNA_URL: ajnaUrl, AJNA_USER: ajnaUser, AJNA_PASS: ajnaPass,
    HA_ADMIN_USER: adminUser || null,
    HA_INSTANCE: haInstance, MQTT_PORT: mqttPort,
    MQTT_HA_USER: mqttHaUser, MQTT_HA_PASS: mqttHaPass,
    MQTT_TLS_CERT: tls.cert || null, MQTT_TLS_KEY: tls.key || null,
    MQTT_TLS_AUTO: tls.auto ? '1' : null, MQTT_TLS_SAN: tls.san || null,
    HA_LAT: haLat, HA_LON: haLon,
  }, 'Home-Assistant-Gateway — erneut konfigurieren: node agents/homeassistant-gateway.mjs --setup')
  ok(`Konfiguration gespeichert: ${envPath}`)

  const host = tls.san || cad.domains[0] || '<gateway-host>'
  const guidePath = resolve(REPO_ROOT, 'agents', `ha-setup-${haInstance}.md`)
  writeFileSync(guidePath, haGuide({ host, mqttPort, mqttHaUser, mqttHaPass, haInstance, tlsMode }), 'utf8')
  ok(`HA-Anleitung geschrieben: ${guidePath}`)
  hint('Enthält die UI-Schritte für die MQTT-Integration, den mqtt_statestream-Schnipsel und die Kommando-Automation.')

  // ── pm2 ────────────────────────────────────────────────────────────────
  // Verwaltet pm2 das Gateway bereits (z. B. via ecosystem.config.cjs als
  // "homeassistant-gateway"), KEINE zweite Registrierung — zwei Instanzen
  // kollidieren am MQTT-Port. Stattdessen Restart mit frischer Config anbieten.
  const managed = pm2Processes().filter(p =>
    ['ajna-ha-gateway', 'homeassistant-gateway'].includes(p.name)
    || /homeassistant-gateway/.test(`${p.script} ${p.args}`))
  if (managed.length) {
    infoLine(`pm2 verwaltet das Gateway bereits: ${managed.map(p => p.name).join(', ')} — keine erneute Registrierung.`)
    if (await confirm(rl, `Jetzt mit der neuen Konfiguration neu starten (pm2 restart ${managed[0].name})?`, true)) {
      try { pm2Restart(managed[0].name); ok('Neu gestartet.') }
      catch (e) { warnLine(`pm2 restart fehlgeschlagen: ${e?.message || e} — bitte manuell: pm2 restart ${managed[0].name}`) }
    }
    rl.close(); return { exit: true }   // Vordergrund-Start würde mit der pm2-Instanz kollidieren
  }
  if (pm2Available() && await confirm(rl, 'Gateway jetzt bei pm2 registrieren (Autostart)?', true)) {
    try {
      pm2Register({ name: 'ajna-ha-gateway', script: 'agents/homeassistant-gateway.mjs' })
      ok('Bei pm2 registriert (ajna-ha-gateway). Dieser Prozess beendet sich jetzt.')
      rl.close(); return { exit: true }
    } catch (e) { warnLine(`pm2-Registrierung fehlgeschlagen: ${e?.message || e} — Start im Vordergrund.`) }
  }
  rl.close()
  banner('Einrichtung abgeschlossen — Gateway startet …')
  return { exit: false }
}

function haGuide({ host, mqttPort, mqttHaUser, mqttHaPass, haInstance, tlsMode }) {
  return `# Home Assistant ↔ Ajna — Einrichtung (Instanz „${haInstance}")

## 1. MQTT-Integration verbinden (HA-Oberfläche)
Einstellungen → Geräte & Dienste → Integration hinzufügen → **MQTT**:

| Feld | Wert |
|---|---|
| Broker | \`${host}\` |
| Port | \`${mqttPort}\` |
| Benutzername | \`${mqttHaUser}\` |
| Passwort | \`${mqttHaPass}\` |
${tlsMode === 'none' ? '| Verschlüsselung | aus (nur LAN!) |' : '| Verschlüsselung | **aktivieren** |'}
${tlsMode === 'auto' ? '\n> Selbstsigniertes Zertifikat: beim Verbinden das Zertifikat akzeptieren/pinnen\n> (Fingerprint zeigt das Gateway beim Start an).' : ''}

> Empfehlung für die MQTT-Optionen: **Discovery deaktivieren** (Ajna nutzt kein
> MQTT-Discovery) und Birth-/Will-Topic auf \`ajna/ha/${haInstance}/status\`
> stellen. Pflicht ist beides nicht — der Broker toleriert die Defaults
> (lehnt sie nur still ab) —, es hält aber Log und Verkehr sauber.

## 2. Zustände nach Ajna spiegeln (configuration.yaml)
\`\`\`yaml
mqtt_statestream:
  base_topic: ajna/ha/${haInstance}
  publish_attributes: true
  include:
    domains:
      - light
      - switch
      # weitere Domains nach Bedarf …
\`\`\`
Danach HA neu starten. Die freigegebenen Entitäten erscheinen automatisch in Ajna.

## 3. Kommandos aus Ajna ausführen (Automation)
Ajna publisht Kommandos auf \`ajna/ha/${haInstance}/<domain>/<entity>/set\`
als JSON \`{"service": "...", "data": {...}}\`. Eine generische Automation —
**in die \`automations.yaml\` eintragen** (ohne \`automation:\`-Schlüssel!) und
danach unter Entwicklerwerkzeuge → YAML die Automationen neu laden:
\`\`\`yaml
- alias: "Ajna: MQTT-Kommandos ausführen"
  trigger:
    - platform: mqtt
      topic: "ajna/ha/${haInstance}/+/+/set"
  action:
    - service: "{{ trigger.topic.split('/')[3] }}.{{ (trigger.payload | from_json).service }}"
      target:
        entity_id: "{{ trigger.topic.split('/')[3] }}.{{ trigger.topic.split('/')[4] }}"
      data: "{{ (trigger.payload | from_json).data | default({}) }}"
\`\`\`
> NICHT als eigener \`automation:\`-Block in die \`configuration.yaml\` — der
> kollidiert mit dem üblichen \`automation: !include automations.yaml\`
> (Duplikat-Key): Die Automation lädt dann nie und die Traces bleiben leer.
> Prüfen: Einstellungen → Automationen — der Eintrag muss dort auftauchen.

## Sicherheit
- Der Broker sperrt diesen Zugang auf den Namespace \`ajna/ha/${haInstance}/#\`.
- HA verbindet sich **ausgehend** — kein offener Port Richtung HA nötig.
- Wer Geräte in Ajna sehen/schalten darf, regeln die Ajna-Berechtigungen.
`
}
