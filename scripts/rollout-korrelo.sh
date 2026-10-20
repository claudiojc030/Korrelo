#!/usr/bin/env bash
# Rollout SEGURO do próprio Korrelo.
#
# Este script NUNCA toca nos containers dos projetos (Mesatta, Evolution API,
# bancos). Ele atualiza somente o Core: código, banco do Core (SQLite),
# processos PM2 do Korrelo e arquivos do Core.
#
# Uso:
#   bash scripts/rollout-korrelo.sh            # DRY-RUN REAL (somente leitura)
#   bash scripts/rollout-korrelo.sh --plan     # só imprime o plano teórico
#   bash scripts/rollout-korrelo.sh --apply    # executa o rollout de verdade
#
# Update de um checkout ALVO diferente do executor (primeiro rollout):
#   bash scripts/rollout-korrelo.sh --repo-root /home/korrelo/korrelo
#   bash scripts/rollout-korrelo.sh --repo-root /home/korrelo/korrelo --apply
#
# Modos:
#   --plan  = imprime o plano. NÃO fala com Docker, nem com o banco.
#   (padrão)= DRY-RUN REAL: executa TODAS as verificações somente leitura
#              (git, banco do Core, host, health e snapshot real dos
#              containers dos projetos) e NÃO escreve nada: sem lock, sem
#              drain, sem backup, sem migration, sem build, sem restart de
#              PM2 e sem nenhum comando Docker de escrita.
#   --apply = o rollout de verdade (o mesmo executor do botão "Atualizar agora").
#
# O alvo (--repo-root) é o checkout do Korrelo que será atualizado. O código,
# a config e as libs do rollout vêm sempre do EXECUTOR (o repositório onde
# este script roda).
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

# O repositório do EXECUTOR tem que ser um repositório Git válido. A checagem
# é feita pelo próprio Git (funciona em worktree, onde `.git` é ARQUIVO e não
# diretório - `git worktree` nunca tem `.git` como pasta).
git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "a raiz do executor não é um repositório Git válido: $REPO_ROOT"

# A partir daqui, nada é executado sem o CLI (que tem o dry-run como padrão
# e aborta em qualquer precondição falha). Os argumentos são repassados
# intactos (--plan, --apply, --repo-root <path>); o CLI faz o parsing
# explícito e ABORTA em qualquer argumento desconhecido.
log "repositório (executor): $REPO_ROOT"
log "modo: ${*:-dry-run}"

exec node "$CLI" "$@"
