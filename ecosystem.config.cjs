// ecosystem.config.cjs — PM2-Prozessdefinition für den Ajna-Server.
//
// PM2 verwaltet PocketBase, die Express-API und die Agents. Caddy läuft BEWUSST
// separat (braucht Port 443 / root-Privileg und ändert sich selten). Deployen
// über scripts/deploy.sh (git pull → build → pm2 reload).
//
// CommonJS (.cjs), weil package.json "type":"module" ist — PM2 require()t diese
// Datei. Einrichtung + Nutzung: siehe docs/deployment.md.

const ROOT = __dirname

// Agents, die die Welt bevölkern (wie `npm run stack:all`). Jeder wartet über
// scripts/agent-wrapped.sh erst auf ein erreichbares Backend. Nicht benötigte
// hier auskommentieren.
const AGENTS = [
  'poi-bridge',
  'ais-bridge',
  'adsb-bridge',   // Flugzeuge aus OpenSky; läuft anonym, optional OAuth2 (.env)
  'wigle-bridge',
  'world-director',
  'homeassistant-gateway', // MQTT-Gateway: eingebetteter Broker (Port 1883) +
                           // HA-Anbindung. BRAUCHT MQTT_HA_USER/MQTT_HA_PASS in
                           // der .env DIESER Umgebung — sonst fail-fast (exit 1)
                           // → pm2-Restart-Loop. .env ist nicht eingecheckt, also
                           // pro Server separat setzen (docs/homeassistant.md).
  // 'wand-agent',   // optional: Online-Teil der Zauberstab-Kette (legt ein
  //                  // Demo-Zielobjekt an, schaltet animation_state auf wand_*).
  //                  // Nur nötig, wenn du diese spezielle Wand-Demo willst.
]

module.exports = {
  apps: [
    {
      name: 'pocketbase',
      script: './pocketbase/pocketbase',   // Linux-Binary; loopback-only in Prod
      args: 'serve --http=127.0.0.1:8090',
      interpreter: 'none',                  // natives Binary, kein Node
      cwd: ROOT,
      autorestart: true,
      time: true,
    },
    {
      name: 'api',
      script: 'server/index.js',            // ESM; Node respektiert "type":"module"
      cwd: ROOT,
      autorestart: true,
      time: true,
    },
    {
      // Statischer Client auf 8888 — die Caddyfile.prod proxyt den nicht-API-
      // Verkehr per `handle { reverse_proxy 127.0.0.1:8888 }` hierher. (Wer im
      // Caddyfile stattdessen `file_server` nutzt, kann diesen Dienst weglassen.)
      name: 'client',
      script: 'node_modules/serve/build/main.js',
      args: 'client --listen 8888 --no-port-switching',
      cwd: ROOT,
      autorestart: true,
      time: true,
    },
    ...AGENTS.map(name => ({
      name,
      script: './scripts/agent-wrapped.sh', // wartet auf den Stack, dann node agents/<name>.mjs
      args: name,
      interpreter: 'bash',
      cwd: ROOT,
      autorestart: true,
      restart_delay: 5000,
      time: true,
    })),
  ],
}
