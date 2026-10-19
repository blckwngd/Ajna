// ecosystem.config.cjs — PM2-Prozessdefinition für den Ajna-Server.
//
// PM2 verwaltet PocketBase, die Express-API und die Agents. Caddy läuft BEWUSST
// separat (braucht Port 443 / root-Privileg und ändert sich selten). Deployen
// über scripts/deploy.sh (git pull → build → pm2 reload).
//
// CommonJS (.cjs), weil package.json "type":"module" ist — PM2 require()t diese
// Datei. Einrichtung + Nutzung: siehe docs/deployment.md.

const ROOT = __dirname

// ─── Speicher auf einer kleinen Maschine ────────────────────────────────────
//
// Der Ajna-Server ist eine VM mit 2 GB. Im Oktober 2026 ist dort mehrfach
// PocketBase gestorben und die ganze Maschine hing, bis sie neu gestartet
// wurde. Das ist die Handschrift des Kernel-OOM-Killers auf einem System ohne
// Swap: er sucht sich den grössten Prozess, und das war die Datenbank.
//
// DREI SCHICHTEN, und jede tut etwas anderes:
//
//   1. V8-Heapgrenze (scripts/agent-wrapped.sh) — WIRKT VORHER. Sie sagt jedem
//      Agenten, ab wann er aufräumen statt wachsen soll. Das ist die einzige
//      Schicht, die den Engpass vermeidet, statt auf ihn zu reagieren.
//   2. max_memory_restart (hier) — FÄNGT AUF. Wächst ein Agent trotzdem, holt
//      pm2 ihn geordnet zurück, bevor der Kernel jemanden aussucht.
//   3. Swap + OOM-Gewichtung auf dem Server — LETZTE INSTANZ, siehe
//      docs/deployment.md. Ohne Swap gibt es kein Durchatmen: der Kernel hat
//      nur die Wahl zwischen Töten und Hängen.
//
// Gemessen am 19.10.2026 (Entwicklungsrechner, neun Agents, halbe Stunde):
// cits-bridge 177 MB, world-director 93–203 MB, alle übrigen 22–45 MB,
// PocketBase 66–71 MB. Die Grenzen unten haben darauf Luft, aber keine Weite.
//
// DIE SUMME MUSS IN DIE MASCHINE PASSEN. Das klingt selbstverständlich und war
// es beim ersten Entwurf nicht: zehn Agents mit je 160 MB Marke plus API,
// Client, PocketBase und Caddy ergaben 2199 MB auf einer 2-GB-VM. Ein
// Auffangnetz, dessen Maschen zusammen grösser sind als der Raum, sichert
// nichts zu — es verschiebt den OOM-Killer nur um ein paar Minuten. Deshalb
// rechnet diese Datei am Ende selbst nach und sagt es, wenn es nicht aufgeht.
//
// DIE MARKE MUSS ÜBER DER HEAPGRENZE LIEGEN, sonst holt pm2 den Agenten zurück,
// BEVOR V8 je aufräumen muss — dann ist das Heap-Budget wirkungslos und der
// Agent hängt in einer Neustartschleife. Die Rechnung dazu, gemessen am
// 19.10.2026 mit Node 25.8:
//
//   Heap-Grenze (old=96, semi=8)            120 MB
//   + Grundlast eines frischen Node          49 MB   ← nicht verhandelbar
//   = Obergrenze im Betrieb                 ~165 MB
//   → Marke 192 MB (gut 25 MB Luft)
//
// Diese 49 MB sind der Grund, warum zehn Agents auf 2 GB nicht garantiert
// unterzubringen sind: ein halbes Gigabyte ist weg, bevor einer etwas tut.
// EINE QUELLE FÜR BEIDE ZAHLEN. Das Heap-Budget steht im Wrapper, die Marke
// hier — und sie müssen zueinander passen, sonst holt pm2 den Agenten zurück,
// bevor V8 aufräumt. Also wird hier beides festgelegt und das Budget als
// Umgebungsvariable an den Wrapper durchgegeben. Marke = Heap + 48 (Halbräume)
// + 49 (Node-Grundlast) + Luft.
const AGENT_HEAP = {
  // cits parst Verkehrsmeldungen im Sekundentakt — der höchste Umsatz im Feld
  // (gemessen 177 MB ohne Budget, 99 MB mit). Grössere junge Fläche, weil hier
  // laufend kurzlebiger Müll anfällt: zu klein gewählt wandert der in den alten
  // Bereich und wird dort teuer.
  'cits-bridge': { heap: 160, semi: 8 },
  // der Director hält Wegegraphen (~1 MB je 300-m-Zelle, begrenzt über
  // WD_GRAPH_CACHE_MAX) und dazu die Figuren (203 MB ohne, 107 MB mit).
  'world-director': { heap: 160, semi: 8 },
}
const AGENT_HEAP_DEFAULT = { heap: 96, semi: 4 }

/**
 * Die Marke aus dem Budget. Sie MUSS über der Heap-Obergrenze liegen, sonst
 * holt pm2 den Agenten zurück, bevor V8 je aufräumen muss — dann ist das
 * Budget wirkungslos und der Agent hängt in einer Neustartschleife. Sie darf
 * aber auch nicht beliebig darüber liegen, sonst feuert sie nie und ist Zierde.
 *
 *   Heap-Grenze = heap + 3 × semi      (drei Halbräume, gemessen bestätigt)
 *   + 49 MB                            Grundlast eines frischen Node
 *   + 25 MB                            Luft für Puffer ausserhalb des Heaps
 */
const markeFuer = ({ heap, semi }) => heap + 3 * semi + 49 + 25
// Was der Maschine neben pm2 noch gehört: PocketBase (gemessen 66–71 MB),
// Caddy (~25 MB) und das Betriebssystem.
const RESERVIERT_MB = 70 + 25 + 250
const MASCHINE_MB = parseInt(process.env.AJNA_HOST_MB || '2048', 10)

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
  // Adress-Lupe. AN, SOLANGE DIE INSTANZ NICHT ÖFFENTLICH IST (Testphase,
  // bestätigt 16.10.2026). Der Kommentar hier sagte zuvor „BEWUSST AUS",
  // während die Zeile aktiv war — ein Widerspruch, der niemandem hilft.
  //
  // VOR DER ÖFFNUNG ENTSCHEIDEN: Der Agent trägt Angaben über Adressen
  // zusammen, im Modus `erweitert` auch über Privatpersonen, und die Netzspur
  // nennt Hoster und Registerinhaber. Wer ihn öffentlich anbietet, entscheidet
  // als Betreiber über Zweck und Mittel. Braucht `agents/.env.address-bridge`
  // (npm run address:setup) und optional die Abzüge unter `.cache/`.
  // Siehe docs/adress-anreicherung-quellen.md.
  'address-bridge',
  'cits-bridge',  // Straßenverkehr über opentrafficmap.org. Spiegelt in der
  //                 // Vorgabe AUCH private Fahrzeuge (CITS_PRIVAT=off nimmt sie
  //                 // aus). Braucht `agents/.env.cits` — Name des Agenten ist
  //                 // `cits`, nicht `cits-bridge`.
  // 'aprs-bridge',  // Amateurfunk-Positionsbaken über APRS-IS. Braucht
  //                 // `agents/.env.aprs` mit APRS_CALL (Kennung für die
  //                 // Anmeldung; nur Empfang, Passcode -1 steht fest im Code).
  //                 // Der Agent-Name ist `aprs`, nicht `aprs-bridge`.
  //                 // ACHTUNG: Port 14580 muss ausgehend offen sein — in
  //                 // manchen Netzen ist er gesperrt (npm run aprs:capture
  //                 // sagt es dir in zwanzig Sekunden).
  'movebank-bridge',   // besenderte Wildtiere. Braucht Zugangsdaten.
  'ais-vesselfinder',  // zweite Schiffsquelle. Braucht Zugangsdaten.
  // 'uwb-anchors',       // UWB-Anker aus einer JSON-Datei. Braucht die Datei.
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
      // Graceful-Shutdown-Fenster: pm2 killt sonst nach 1,6 s hart — PB braucht
      // beim Beenden Zeit für den SQLite-WAL-Checkpoint. Ein abgewürgter
      // Checkpoint = minutenlange, stumme WAL-Recovery beim nächsten Boot.
      kill_timeout: 30000,
      // KEIN max_memory_restart — mit Absicht. PocketBase ist der Prozess, den
      // alle anderen brauchen; ihn wegen eines Zahlenwerts neu zu starten
      // heisst, die Welt für eine halbe Minute anzuhalten, und ein
      // abgebrochener WAL-Checkpoint kostet beim nächsten Start weit mehr.
      // Gemessen: 66–71 MB im Betrieb, stabil. Wächst PocketBase, ist das ein
      // Befund und kein Fall für einen Automaten. Wovor es geschützt werden
      // muss, ist der OOM-Killer des Kernels — das steht in docs/deployment.md.
      //
      // Ebenfalls geprüft und VERWORFEN: --hooksPool kleiner stellen. Die
      // Vorgabe 15 klingt nach viel, kostet aber gemessen nur 4 MB gegenüber 1
      // (goja compiliert faul). Dafür die Hook-Nebenläufigkeit zu opfern wäre
      // ein schlechtes Geschäft.
      time: true,
    },
    {
      name: 'api',
      script: 'server/index.js',            // ESM; Node respektiert "type":"module"
      cwd: ROOT,
      autorestart: true,
      // Die Express-API hält den Geo-Cache (Overpass-Antworten). Derselbe
      // Gedanke wie bei den Agents: eine Heapgrenze lässt V8 früher aufräumen.
      node_args: '--max-old-space-size=96 --max-semi-space-size=4',
      max_memory_restart: '182M',
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
      // Ein Dateiserver braucht keinen grossen Heap; was er liefert, geht am
      // Heap vorbei durch den Kernel.
      node_args: '--max-old-space-size=48 --max-semi-space-size=4',
      max_memory_restart: '134M',
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
      // Das Auffangnetz, nicht die Grenze — die steht im Wrapper (V8-Heap).
      // Greift das hier regelmässig, ist der Heapwert für diesen Agenten zu
      // knapp oder er hält etwas fest, das er nicht halten sollte; dann gehört
      // das untersucht und nicht die Zahl erhöht.
      max_memory_restart: `${markeFuer(AGENT_HEAP[name] || AGENT_HEAP_DEFAULT)}M`,
      // Der Wrapper liest das und setzt daraus --max-old-space-size und
      // --max-semi-space-size. So stehen die Zahlen an EINER Stelle, und
      // Budget und Marke können nicht auseinanderlaufen.
      env: {
        AJNA_HEAP_MB: String((AGENT_HEAP[name] || AGENT_HEAP_DEFAULT).heap),
        AJNA_SEMI_MB: String((AGENT_HEAP[name] || AGENT_HEAP_DEFAULT).semi),
      },
      time: true,
    })),
  ],
}

// ─── Die Probe aufs Exempel ─────────────────────────────────────────────────
//
// pm2 liest diese Datei bei jedem Start und Reload. Das ist der einzige
// Zeitpunkt, an dem jemand garantiert hinsieht — also wird hier nachgerechnet.
// KEIN Abbruch: wer bewusst überbucht (etwa weil Swap da ist), soll deployen
// dürfen. Aber er soll es gelesen haben.
{
  const summe = module.exports.apps
    .map(a => parseInt(String(a.max_memory_restart || '0'), 10) || 0)
    .reduce((s, v) => s + v, 0)
  const platz = MASCHINE_MB - RESERVIERT_MB
  if (summe > platz) {
    // Wie viele Agents DOCH passen — eine Warnung, die nur „zu viel" sagt,
    // lässt den Betreiber raten. Die teuren zuerst: cits und der Director sind
    // die, wegen derer man den Stack überhaupt betreibt.
    const grund = module.exports.apps
      .filter(a => ['api', 'client'].includes(a.name))
      .reduce((s, a) => s + (parseInt(String(a.max_memory_restart || '0'), 10) || 0), 0)
    let rest = platz - grund, passen = 0
    for (const a of module.exports.apps.filter(a => !['api', 'client', 'pocketbase'].includes(a.name))) {
      const m = parseInt(String(a.max_memory_restart || '0'), 10) || 0
      if (m > rest) break
      rest -= m; passen++
    }
    const gesamt = module.exports.apps.length - 3
    console.warn(
      `\n⚠ SPEICHER ÜBERBUCHT: die Neustart-Marken ergeben zusammen ${summe} MB,`
      + `\n  verfügbar sind etwa ${platz} MB (${MASCHINE_MB} MB Maschine minus`
      + `\n  ${RESERVIERT_MB} MB für PocketBase, Caddy und das System).`
      + `\n  Erreichen alle Dienste gleichzeitig ihre Marke, greift der OOM-Killer`
      + `\n  VOR pm2 — und er sucht sich den grössten Prozess, also die Datenbank.`
      + `\n`
      + `\n  In dieser Reihenfolge passen ${passen} der ${gesamt} Agents.`
      + `\n  Abhilfe: Agents in AGENTS auskommentieren, Marken senken, Swap`
      + `\n  einrichten (docs/deployment.md) oder AJNA_HOST_MB setzen, wenn die`
      + `\n  Maschine grösser ist als angenommen.\n`)
  } else {
    console.log(`[pm2] Speicherrechnung: ${summe} MB Marken von ${platz} MB verfügbar `
      + `(${MASCHINE_MB} MB Maschine).`)
  }
}
