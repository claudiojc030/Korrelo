#!/usr/bin/env bash
# Bootstrap de um clique: baixa o Korrelo numa VPS Ubuntu limpa e já dispara
# o setup-vps.sh. Uso:
#   curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh | bash
#
# Prefere revisar antes de rodar? Baixe o arquivo, leia, e execute na mão:
#   curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh -o install.sh
#   less install.sh && bash install.sh
set -euo pipefail

REPO_URL="https://github.com/claudiojc030/Korrelo.git"
INSTALL_DIR="${KORRELO_INSTALL_DIR:-$HOME/korrelo}"

log() { echo -e "\n\033[1;32m==> $1\033[0m"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Não rode como root. Rode como um usuário normal com sudo (evita rodar o Core como root)." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  log "Instalando git"
  sudo apt-get update -y
  sudo apt-get install -y git
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Já existe um clone em $INSTALL_DIR, atualizando"
  git -C "$INSTALL_DIR" pull
else
  log "Clonando o Korrelo em $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
exec bash scripts/setup-vps.sh
