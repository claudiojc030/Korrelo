#!/usr/bin/env bash
# Self-update do KORRELO (botão "Atualizar agora" do painel).
#
# Este script é um ATALHO para o mesmo executor usado pelo rollout seguro
# (scripts/rollout-korrelo.sh). Os dois caminhos passam exatamente pela mesma
# lógica, então têm a MESMA proteção:
#
#   - não roda no meio de um deploy de projeto (recusa se houver job em
#     andamento);
#   - não descarta alteração local do working tree (aborta se estiver sujo);
#   - backup consistente do banco do Core ANTES de qualquer migration;
#   - snapshot READ-ONLY dos containers dos projetos antes e depois, com
#     comparação de Container ID, imagem, StartedAt, RestartCount, memória,
#     swap, restart policy, mounts, redes e portas (divergência = falha
#     crítica, sem tocar no projeto);
#   - prepara os assets do Next standalone (.next/static e public/);
#   - reinicia SOMENTE o PM2 do Core (korrelo-api e korrelo-web);
#   - em falha, volta o Core ao commit anterior (rebuild + restart do Core).
#
# NUNCA toca em container, volume, rede, porta ou banco de projeto.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CLI="${REPO_DIR}/apps/api/scripts/rollout/rollout.cjs"

if ! command -v node >/dev/null 2>&1; then
  echo "__KORRELO_UPDATE_DONE__|failed|node não encontrado (Node 20+ é obrigatório)"
  exit 1
fi

if [ ! -f "$CLI" ]; then
  echo "__KORRELO_UPDATE_DONE__|failed|CLI de rollout não encontrado: $CLI"
  exit 1
fi

echo "[self-update] delegando para o executor de rollout seguro: $CLI"
exec node "$CLI" --apply
