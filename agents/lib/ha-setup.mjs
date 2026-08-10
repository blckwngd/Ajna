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
} from './setup-wizard.mjs'

const AGENT = 'ha-gateway'

export async function runHaSetup() {
  const rl = makeRl()
  const env = process.env
  console.log('\n══ Ajna · Home-Assistant-Gateway — Einrichtung ══\n')

  // ── 1) Ajna-Instanz ────────────────────────────────────────────────────
  // AJNA_URL aus der geschichteten .env wird als erster Kandidat mitgeprobt —
  // hinter Caddy (VPS) greifen die Standard-Ports nicht, die .env kennt die URL.
  let ajnaUrl = (env.AJNA_URL || '').replace(/\/+$/, '')
  console.log('Suche laufende Ajna-Instanzen …')
  const local = (await probeLocalAjna([ajnaUrl])).filter(f => f.isAjna)
  const srcLabel = { env: 'aus .env', caddy: 'via Caddyfile', default: 'lokal erkannt' }
  const options = [
    ...local.map(f => `${f.url} (${srcLabel[f.source] || 'erkannt'})`),
    'Andere Instanz (URL eingeben)',
  ]
  const defIdx = ajnaUrl && !local.some(f => f.url === ajnaUrl) ? options.length - 1
    : Math.max(0, local.findIndex(f => f.url === ajnaUrl))
  const pick = await choose(rl, local.length
    ? `${local.length} Ajna-Instanz(en) gefunden — welche soll das Gateway nutzen?`
    : 'Keine laufende Ajna-Instanz gefunden (geprüft: AJNA_URL aus .env, Caddyfile-Domains, Standard-Ports).', options, defIdx)
  if (pick < local.length) ajnaUrl = local[pick].url
  else {
    ajnaUrl = await ask(rl, 'Ajna-URL (z. B. https://ajna.example.org)', ajnaUrl)
    const h = await httpGet(`${ajnaUrl}/api/health`, { insecure: true })
    if (!h || h.status !== 200) console.log(`⚠ Instanz antwortet nicht auf /api/health (${h?.error || `HTTP ${h?.status}`}) — bitte URL prüfen (weiter trotzdem möglich).`)
    else console.log('✓ Instanz erreichbar.')
  }

  // ── 2) Gateway-User ────────────────────────────────────────────────────
  let ajnaUser = env.AJNA_USER || '', ajnaPass = env.AJNA_PASS || ''
  const userMode = await choose(rl, 'Ajna-Benutzer für das Gateway:', [
    'Neu anlegen (Superuser-Zugang nötig; Passwort wird generiert)',
    'Vorhandenen Benutzer verwenden',
  ], ajnaUser ? 1 : 0)
  const pb = new PocketBase(ajnaUrl)
  if (userMode === 0) {
    const suEmail = await ask(rl, 'Superuser-E-Mail')
    const suPass = await askHidden(rl, 'Superuser-Passwort (nur für diesen Schritt, wird nicht gespeichert)')
    try {
      await pb.collection('_superusers').authWithPassword(suEmail, suPass)
      console.log('✓ Superuser-Login ok.')
    } catch (e) { console.log(`✗ Superuser-Login fehlgeschlagen: ${e?.message || e}`); rl.close(); return { exit: true } }
    ajnaUser = await ask(rl, 'E-Mail des neuen Gateway-Users', ajnaUser || 'ha-gateway@ajna.local')
    ajnaPass = randomSecret()
    // Sichtbarkeit der angelegten Geräte: default_permissions des Users werden
    // beim Object-Create als ACEs materialisiert (pb_hooks applyOwnerDefaults).
    const aud = await choose(rl, 'Wer soll die HA-Geräte standardmäßig sehen/schalten dürfen?', [
      'Angemeldete Nutzer (authenticated) — empfohlen',
      'Alle (everyone, auch anonym)',
      'Niemand (Rechte später manuell vergeben)',
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
      console.log(`✓ Benutzer ${ajnaUser} angelegt (Passwort generiert).`)
    } catch (e) {
      console.log(`✗ Benutzer-Anlage fehlgeschlagen: ${e?.response?.message || e?.message || e}`)
      rl.close(); return { exit: true }
    } finally { pb.authStore.clear() }   // Superuser-Session verwerfen
  } else {
    ajnaUser = await ask(rl, 'Gateway-User (E-Mail)', ajnaUser)
    ajnaPass = (await askHidden(rl, `Passwort für ${ajnaUser} (Enter = unverändert lassen)`)) || ajnaPass
  }
  try {
    await pb.collection('users').authWithPassword(ajnaUser, ajnaPass)
    console.log('✓ Gateway-Login geprüft.')
    pb.authStore.clear()
  } catch (e) { console.log(`⚠ Gateway-Login fehlgeschlagen (${e?.message || e}) — Werte werden trotzdem gespeichert.`) }

  // ── 3) MQTT ────────────────────────────────────────────────────────────
  const haInstance = (await ask(rl, 'Namespace dieser HA-Instanz', env.HA_INSTANCE || 'home')).replace(/[^a-z0-9_-]/gi, '')
  const mqttHaUser = await ask(rl, 'MQTT-Benutzername für den HA-Client', env.MQTT_HA_USER || `ha_${haInstance}`)
  const mqttHaPass = env.MQTT_HA_PASS && await confirm(rl, 'Vorhandenes MQTT-Passwort behalten?', true)
    ? env.MQTT_HA_PASS : randomSecret()

  // ── 4) TLS (mit Caddy-Bewusstsein) ─────────────────────────────────────
  let tls = { cert: env.MQTT_TLS_CERT || '', key: env.MQTT_TLS_KEY || '', auto: /^(1|true)$/i.test(env.MQTT_TLS_AUTO || ''), san: env.MQTT_TLS_SAN || '' }
  const cad = caddyDomains()
  const tlsOpts = []
  const caddyCerts = []
  for (const d of cad.domains) {
    const c = findCaddyCert(d)
    if (c) { caddyCerts.push({ domain: d, ...c }); tlsOpts.push(`Caddy-Zertifikat mitbenutzen: ${d}${c.readable ? '' : ' (⚠ aktuell NICHT lesbar)'}`) }
  }
  tlsOpts.push('Selbstsigniert (Gateway erzeugt eines; Fingerprint fürs HA-Pinning)')
  tlsOpts.push('Eigene Zertifikat-Pfade angeben')
  tlsOpts.push('Kein TLS (nur LAN/Test — unverschlüsselt!)')
  const tlsPick = await choose(rl, 'TLS für den MQTT-Broker:', tlsOpts, tls.cert ? tlsOpts.length - 2 : (caddyCerts.length ? 0 : tlsOpts.length - 3))
  let tlsMode
  if (tlsPick < caddyCerts.length) {
    const c = caddyCerts[tlsPick]
    tlsMode = 'caddy'; tls = { cert: c.crt, key: c.key, auto: false, san: '' }
    if (!c.readable) console.log('⚠ Zertifikat/Key sind für diesen Benutzer nicht lesbar — Leserechte gewähren\n  (z. B. Gateway als selber Benutzer wie Caddy laufen lassen oder Gruppen-Leserecht setzen).')
    console.log('ℹ Caddy erneuert das Zertifikat automatisch (~60–90 Tage) — danach Gateway neu starten (pm2 restart).')
  } else if (tlsPick === caddyCerts.length) {
    tlsMode = 'auto'
    const san = await ask(rl, 'Hostname/IP, unter der HA den Broker erreicht (fürs Zertifikat-SAN)', tls.san || cad.domains[0] || '')
    tls = { cert: '', key: '', auto: true, san }
  } else if (tlsPick === caddyCerts.length + 1) {
    tlsMode = 'manual'
    tls.cert = await ask(rl, 'Pfad Zertifikat (PEM)', tls.cert)
    tls.key = await ask(rl, 'Pfad Private Key (PEM)', tls.key)
    tls.auto = false
  } else { tlsMode = 'none'; tls = { cert: '', key: '', auto: false, san: '' } }
  const mqttPort = parseInt(await ask(rl, 'MQTT-Broker-Port', env.MQTT_PORT || (tlsMode === 'none' ? '1883' : '8883')), 10)
  console.log(`ℹ Firewall: Port ${mqttPort}/tcp eingehend öffnen — MQTT läuft NICHT über Caddy (rohes TCP).`)

  // ── 5) Controller-Koordinaten ──────────────────────────────────────────
  console.log('Wo steht die HA-Instanz? (grob reicht — später per Karte/Gizmo exakt schieben)')
  const haLat = await ask(rl, 'Breitengrad (lat)', env.HA_LAT || '50.3569')
  const haLon = await ask(rl, 'Längengrad (lon)', env.HA_LON || '7.5890')

  // ── 6) Schreiben ───────────────────────────────────────────────────────
  const envPath = writeAgentEnv(AGENT, {
    AJNA_URL: ajnaUrl, AJNA_USER: ajnaUser, AJNA_PASS: ajnaPass,
    HA_INSTANCE: haInstance, MQTT_PORT: mqttPort,
    MQTT_HA_USER: mqttHaUser, MQTT_HA_PASS: mqttHaPass,
    MQTT_TLS_CERT: tls.cert || null, MQTT_TLS_KEY: tls.key || null,
    MQTT_TLS_AUTO: tls.auto ? '1' : null, MQTT_TLS_SAN: tls.san || null,
    HA_LAT: haLat, HA_LON: haLon,
  }, 'Home-Assistant-Gateway — erneut konfigurieren: node agents/homeassistant-gateway.mjs --setup')
  console.log(`\n✓ Konfiguration gespeichert: ${envPath}`)

  // ── 7) HA-Anleitung generieren ─────────────────────────────────────────
  const host = tls.san || cad.domains[0] || '<gateway-host>'
  const guidePath = resolve(REPO_ROOT, 'agents', `ha-setup-${haInstance}.md`)
  writeFileSync(guidePath, haGuide({ host, mqttPort, mqttHaUser, mqttHaPass, haInstance, tlsMode }), 'utf8')
  console.log(`✓ HA-Anleitung geschrieben: ${guidePath}`)
  console.log(`  → enthält die UI-Schritte für die MQTT-Integration + den mqtt_statestream-Schnipsel.`)

  // ── 8) pm2 ─────────────────────────────────────────────────────────────
  // Verwaltet pm2 das Gateway bereits (z. B. via ecosystem.config.cjs als
  // "homeassistant-gateway"), KEINE zweite Registrierung — zwei Instanzen
  // kollidieren am MQTT-Port. Stattdessen Restart mit frischer Config anbieten.
  const managed = pm2Processes().filter(p =>
    ['ajna-ha-gateway', 'homeassistant-gateway'].includes(p.name)
    || /homeassistant-gateway/.test(`${p.script} ${p.args}`))
  if (managed.length) {
    console.log(`ℹ pm2 verwaltet das Gateway bereits: ${managed.map(p => p.name).join(', ')} — keine erneute Registrierung.`)
    if (await confirm(rl, `Jetzt mit der neuen Konfiguration neu starten (pm2 restart ${managed[0].name})?`, true)) {
      try { pm2Restart(managed[0].name); console.log('✓ Neu gestartet.') }
      catch (e) { console.log(`⚠ pm2 restart fehlgeschlagen: ${e?.message || e} — bitte manuell: pm2 restart ${managed[0].name}`) }
    }
    rl.close(); return { exit: true }   // Vordergrund-Start würde mit der pm2-Instanz kollidieren
  }
  if (pm2Available() && await confirm(rl, 'Gateway jetzt bei pm2 registrieren (Autostart)?', true)) {
    try {
      pm2Register({ name: 'ajna-ha-gateway', script: 'agents/homeassistant-gateway.mjs' })
      console.log('✓ Bei pm2 registriert (ajna-ha-gateway). Dieser Prozess beendet sich jetzt.')
      rl.close(); return { exit: true }
    } catch (e) { console.log(`⚠ pm2-Registrierung fehlgeschlagen: ${e?.message || e} — Start im Vordergrund.`) }
  }
  rl.close()
  console.log('\n══ Einrichtung abgeschlossen — Gateway startet … ══\n')
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
