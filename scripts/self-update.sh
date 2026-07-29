#!/usr/bin/env bash
# Disparado pelo botão "Atualizar agora" do dashboard (ver StartSelfUpdateUseCase
# / ScriptSelfUpdater). Roda destacado do processo da API: o `pm2 restart` no
# fim derruba o próprio processo Node que iniciou este script, mas como ele foi
# spawnado com { detached: true } isso não afeta este processo bash. Por isso
# toda a saída vai pro arquivo de log em vez de stdout do processo pai (que
# deixa de existir no meio da execução).
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

step() {
  # Formato consumido pelo ScriptSelfUpdater ao parsear o log: percentual e
  # rótulo legível, um por linha, sempre a versão mais recente é a que vale.
  echo "__KORRELO_UPDATE_STEP__|$1|$2"
}

fail() {
  echo "__KORRELO_UPDATE_DONE__|failed|$1"
  exit 1
}

step 5 "Baixando atualização do GitHub"
git pull || fail "git pull falhou"

step 15 "Instalando dependências"
npm install || fail "npm install falhou"

step 45 "Buildando pacotes compartilhados"
npm run build --workspace=packages/shared-types || fail "build de shared-types falhou"

step 60 "Buildando a API"
npm run build --workspace=apps/api || fail "build da API falhou"

step 80 "Buildando a Web"
npm run build --workspace=apps/web || fail "build da Web falhou"

step 85 "Copiando assets estáticos da Web"
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static 2>/dev/null || true

step 92 "Aplicando migrations do banco"
(cd apps/api && npx prisma migrate deploy) || fail "migrations falharam"

step 100 "Reiniciando serviços"
echo "__KORRELO_UPDATE_DONE__|success"
pm2 restart ecosystem.config.js
