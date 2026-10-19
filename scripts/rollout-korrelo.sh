#!/usr/bin/env bash
# Rollout SEGURO do próprio Korrelo.
#
# Este script NUNCA toca nos containers dos projetos (Mesatta, Evolution API,
# bancos). Ele atualiza somente o Core: código, banco do Core (SQLite),
# processos PM2 do Korrelo e arquivos do Core.
#
# Uso:
#   bash scripts/rollout-korrelo.sh            # dry-run (padrão, não altera nada)
#   bash scripts/rollout-korrelo.sh --apply    # executa o rollout de verdade
#   bash scripts/rollout-korrelo.sh --plan     # só imprime o plano
#
# Stages (executados pelo CLI, na ordem):
#    1. preflight             - ambiente, git, disco, Docker acessível
#    2. lock                  - ~/.korrelo/self-update.lock (um rollout por vez)
#    3. worker-drain          - o worker de deploy para de pegar jobs novos
#    4. git-check             - working tree sujo ABORTA (nada é descartado)
#    5. project-snapshot-before - leitura (docker ps/inspect) dos projetos
#    6. core-backup           - backup consistente do banco do Core (sqlite3 .backup)
#    7. git-update            - git pull --ff-only
#    8. install               - npm install
#    9. build-shared          - packages/shared-types
#   10. build-api             - apps/api
#   11. build-web             - apps/web
#   12. migration             - prisma migrate deploy (SÓ depois do backup válido)
#   13. permissions           - .env e dev.db do Core com 600
#   14. pm2-restart           - reinicia SOMENTE korrelo-api e korrelo-web
#   15. health-core           - API, web, PM2 e banco respondendo
#   16. project-snapshot-after - leitura dos projetos
#   17. compare-projects      - divergência = FALHA CRÍTICA (sem corrigir nada)
#   18. worker-release        - devolve o worker
#   19. complete
#
# Em erro: o CLI avalia o ROLLBACK DO CORE (volta ao commit anterior,
# rebuild, reinicia SÓ o PM2 do Core e valida o health). Os containers de
# projeto NUNCA são reiniciados, recriados ou reconfigurados - nem no
# rollback.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
CLI="${REPO_ROOT}/apps/api/scripts/rollout/rollout.cjs"

log() {
  echo "[rollout] $*"
}

fail() {
  echo "[rollout] ERRO: $*" >&2
  exit 1
}

# --- pré-requisitos -------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node não encontrado (Node 20+ é obrigatório)"
[ -f "$CLI" ] || fail "CLI de rollout não encontrado: $CLI"
[ -d "$REPO_ROOT/.git" ] || fail "a raiz do repositório não foi encontrada em $REPO_ROOT"

# A partir daqui, nada é executado sem o CLI (que tem o dry-run como padrão
# e aborta em qualquer precondição falha).
log "repositório: $REPO_ROOT"
log "modo: $*"

exec node "$CLI" "$@"
