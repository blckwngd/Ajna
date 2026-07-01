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
node scripts/wait-stack.mjs
exec node "agents/$1.mjs"
