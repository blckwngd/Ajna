// system-ca — gemeinsamer Re-Exec-Helper für die Node-Agents.
//
// Damit Node Caddys INTERNER CA (`tls internal`, self-signed) vertraut, muss
// es mit `--use-system-ca` (OS-Keystore) gestartet werden. Das Flag wirkt nur
// beim Start, deshalb startet sich der Agent einmalig selbst neu damit.
//
// Robust gegen drei Stolperfallen:
//   1. Öffentliche Zerts (Let's Encrypt, z. B. https://ajna.rethink-ev.de):
//      Node vertraut ihnen OHNEHIN — das Flag ist unnötig.
//   2. Ältere Node-Versionen ohne das Flag (z. B. /usr/bin/node auf manchen
//      Distros) würfen "bad option: --use-system-ca" und der Agent stürbe.
//      → Wir prüfen vorher, ob dieses Node das Flag überhaupt kennt.
//   3. Eigene CA-Verwaltung: per AJNA_NO_SYSTEM_CA=1 komplett abschaltbar
//      (z. B. wenn stattdessen NODE_EXTRA_CA_CERTS=<caddy-root.crt> gesetzt ist).

import { spawnSync } from 'node:child_process'

/**
 * Startet den Agent bei Bedarf mit `--use-system-ca` neu. Kehrt zurück, wenn
 * kein Re-Exec nötig/möglich ist (dann läuft der Agent normal weiter).
 * @param {string} ajnaUrl  AJNA_URL des Agents
 */
export function maybeReexecWithSystemCa(ajnaUrl) {
  if (!ajnaUrl || !ajnaUrl.startsWith('https://')) return  // HTTP → kein CA-Thema
  if (process.execArgv.includes('--use-system-ca')) return // schon re-exec't
  // ÜBER NODE_OPTIONS GESETZT ZÄHLT AUCH. Flags von dort landen NICHT in
  // `execArgv` (geprüft mit Node 25.8) — ohne diese Zeile startet sich der
  // Agent ein zweites Mal, obwohl das Flag längst wirkt, und der Elternprozess
  // bleibt die ganze Laufzeit über in `spawnSync` stehen. Auf einem 2-GB-Server
  // ist jeder solche Zwilling verschenkter Speicher.
  if ((process.env.NODE_OPTIONS || '').includes('--use-system-ca')) return
  if (process.env.AJNA_NO_SYSTEM_CA === '1') return        // explizit aus
  if (!process.argv[1]) return                             // node -e/REPL: kein Skript zum Re-Exec

  if (!nodeSupportsSystemCa()) {
    // Öffentliche Zerts funktionieren ohne das Flag. Für eine interne CA auf
    // altem Node stattdessen NODE_EXTRA_CA_CERTS=<caddy-root.crt> setzen.
    console.warn('[ca] Node kennt --use-system-ca nicht — übersprungen. '
      + 'Öffentliche Zerts gehen ohne; für eine interne CA NODE_EXTRA_CA_CERTS setzen.')
    return
  }

  // DIE EIGENEN NODE-SCHALTER MITNEHMEN. Ohne `process.execArgv` verlor das
  // Kind alles, was dem Elternteil mitgegeben wurde — vor allem
  // `--max-old-space-size` und `--max-semi-space-size`. Gemessen am
  // 20.10.2026: von neun gestarteten Agents hatten nur die drei eine
  // Heap-Grenze, die über `http://` gehen und deshalb gar nicht re-exec'en;
  // die übrigen sechs meldeten „Heap-Grenze 4288 MB", also keine. Das
  // Speicherbudget war damit genau dort wirkungslos, wo es gebraucht wird.
  //
  // Auf dem Server fiel es nicht auf, weil `scripts/agent-wrapped.sh` das Flag
  // selbst mitgibt und der Re-Exec dann entfällt — ein Loch, das nur beim
  // direkten Start aufgeht (`npm run director`) und das niemand gesehen hätte.
  const r = spawnSync(process.execPath,
    [...process.execArgv, '--use-system-ca', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

/** Prüft (einmaliger No-Op-Start), ob dieses Node `--use-system-ca` akzeptiert. */
function nodeSupportsSystemCa() {
  try {
    const r = spawnSync(process.execPath, ['--use-system-ca', '-e', '0'], { stdio: 'ignore' })
    return r.status === 0
  } catch { return false }
}
