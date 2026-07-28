#!/usr/bin/env bash
# Roda o backup do Core + bancos gerenciados por projeto. Chamado pelo cron
# instalado em setup-vps.sh, ou manualmente: bash scripts/backup.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../apps/api"
node scripts/backup.js
