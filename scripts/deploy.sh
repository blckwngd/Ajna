#!/usr/bin/env bash
# Ajna-Deploy: neueste Version aus git holen, Client bauen, Prozesse via PM2
# aktualisieren. Idempotent — beliebig oft ausführbar. Details: docs/deployment.md.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ git pull …"
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
[ "$before" = "$after" ] && echo "  (Repo war bereits aktuell)"

# npm ci nur bei geänderten Abhängigkeiten (spart bei jedem Deploy Zeit).
if ! git diff --quiet "$before" "$after" -- package.json package-lock.json 2>/dev/null; then
  echo "▶ Abhängigkeiten geändert → npm ci …"
  npm ci
fi

echo "▶ Client-Bundles bauen (npm run build) …"
npm run build

echo "▶ Prozesse neu laden (PM2) …"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "✓ Deploy fertig."
pm2 status
