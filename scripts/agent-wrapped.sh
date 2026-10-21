#!/usr/bin/env bash
# PM2-Wrapper für Agents: wartet, bis der Stack (Caddy → PocketBase) erreichbar
# ist, und startet dann den Agent. $1 = Agent-Dateiname ohne .mjs.
#
# Gleiche Gating-Logik wie `npm run stack:all`, damit ein Agent nach Boot/Deploy
# nicht gegen ein noch nicht fertiges Backend läuft. wait-stack.mjs pollt
# https://localhost/api/health (bis 90 s) und exit't 1 bei Timeout → PM2 startet
# den Wrapper neu und versucht es erneut.
set -euo pipefail
cd "$(dirname "$0")/.."

AGENT="$1"
# Weitere Argumente gehen an den Agenten durch — eine Persona braucht
# `--persona <name>`, alle anderen Agents brauchen nichts.
shift

# ─── Speicherbudget ──────────────────────────────────────────────────────────
#
# WARUM HIER EINE GRENZE STEHT. Der Ajna-Server ist eine VM mit 2 GB. Ohne
# Vorgabe richtet V8 seinen Heap nach dem GESAMTEN Arbeitsspeicher der Maschine
# und lässt ihn bis in den Gigabyte-Bereich wachsen, bevor es ernsthaft
# aufräumt — bei zehn Agents gleichzeitig. Gemessen am 19.10.2026: cits-bridge
# stand nach einer halben Stunde bei 177 MB, der world-director kurzzeitig bei
# 203 MB, und keiner von beiden hatte ein Leck. Es war schlicht Müll, den
# niemand einzusammeln aufgefordert hatte. Genau dafür ist diese Zeile da:
#
#   --max-old-space-size=N  heisst nicht „der Agent darf nur N MB",
#   sondern „ab N MB räumt V8 auf, statt zu wachsen".
#
# Der Preis ist Rechenzeit fürs Aufräumen, also etwas langsamere Antworten.
# Das ist die ausdrücklich gewollte Richtung: der Server muss stehen.
#
# Je Agent übersteuerbar — ein Agent mit grossem Bestand darf mehr haben:
#   AJNA_HEAP_MB=192            (für alle)
#   AJNA_HEAP_MB_world_director=256   (nur für diesen; Bindestrich → Unterstrich)
HEAP_DEFAULT="${AJNA_HEAP_MB:-96}"
SEMI_DEFAULT="${AJNA_SEMI_MB:-8}"
# Bindestriche sind in Shell-Variablennamen nicht erlaubt.
AGENT_VAR="AJNA_HEAP_MB_${AGENT//-/_}"
HEAP="${!AGENT_VAR:-$HEAP_DEFAULT}"

NODE_ARGS=()
if [ "$HEAP" != "0" ]; then
  NODE_ARGS+=("--max-old-space-size=$HEAP")
  # DIESE ZEILE IST KEIN BEIWERK. `--max-old-space-size` begrenzt nur den ALTEN
  # Bereich; die junge Fläche legt V8 nach eigenem Ermessen dazu, und das ist
  # auf einer grossen Maschine viel. Gemessen am 19.10.2026 mit Node 25.8:
  #
  #   ohne Flags                      → Grenze 4288 MB
  #   --max-old-space-size=96 allein  → Grenze  288 MB   (!)
  #   dazu --max-semi-space-size=8    → Grenze  120 MB
  #
  # Ohne den Halbraum-Wert ist das Budget also dreifach überschritten, obwohl
  # eine Zahl dasteht. Der Wert gilt je Halbraum, und es gibt drei davon.
  NODE_ARGS+=("--max-semi-space-size=$SEMI_DEFAULT")
fi

# Die System-CA direkt mitgeben, statt den Agent sich selbst neu starten zu
# lassen. system-ca.mjs greift nur zu `spawnSync`, wenn das Flag fehlt — und
# dieser Elternprozess bleibt dann für die ganze Laufzeit als zweite Node-Instanz
# stehen. Über NODE_OPTIONS gesetzt entfällt der Doppelstart ganz.
if node --use-system-ca -e 0 >/dev/null 2>&1; then
  NODE_ARGS+=("--use-system-ca")
fi

node scripts/wait-stack.mjs
echo "[wrapper] $AGENT startet mit ${NODE_ARGS[*]:-ohne Sonderflags}"
exec node "${NODE_ARGS[@]}" "agents/$AGENT.mjs" "$@"
