#!/usr/bin/env bash
# Instala uma versão do Node.js LADO A LADO, sem tocar no node global.
#
# Motivo: trocar o /usr/bin/node de uma VPS que já roda o Korrelo (PM2 + apps)
# deixa o rollback caro. Aqui o runtime novo fica em /opt/korrelo/node/<versao>
# e o PM2 só o usa quando o ecosystem.config.js detecta o caminho (ou recebe
# KORRELO_NODE_BIN).
#
# SEGURANÇA DA INSTALAÇÃO:
# - checksum SHA-256 oficial conferido antes de extrair;
# - extração num diretório de STAGING dentro de /opt (mesmo filesystem);
# - o binário extraído é executado e a versão conferida ANTES de qualquer troca;
# - o symlink `current` é trocado por RENAME ATÔMICO (ln + mv -Tf);
# - se qualquer etapa falhar, `current` NÃO é alterado; se a troca em si falhar,
#   o symlink anterior é restaurado;
# - versões anteriores NUNCA são removidas (rollback sempre disponível).
#
# Uso:
#   bash scripts/install-node-runtime.sh                # 22.23.4 (padrão)
#   bash scripts/install-node-runtime.sh 22.23.5
#
# Depois de instalar:
#   pm2 restart ecosystem.config.js --update-env && pm2 save
#
# NADA é executado automaticamente por este script além do download/extração.
set -euo pipefail

VERSION="${1:-22.23.4}"
ARCH="${KORRELO_NODE_ARCH:-linux-x64}"
ROOT="${KORRELO_NODE_ROOT:-/opt/korrelo/node}"
BASE="https://nodejs.org/dist/v${VERSION}"
TARBALL="node-v${VERSION}-${ARCH}.tar.xz"
EXTRACTED="node-v${VERSION}-${ARCH}"
FINAL_PATH="${ROOT}/${EXTRACTED}"
CURRENT_LINK="${ROOT}/current"
WORK_DIR="$(mktemp -d)"
STAGING=""
PREVIOUS_TARGET=""

cleanup() {
  rm -rf "$WORK_DIR" 2>/dev/null || true
  if [[ -n "$STAGING" ]]; then
    sudo rm -rf "$STAGING" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Versão inválida: '$VERSION' (esperado algo como 22.23.4)" >&2
  exit 64
fi

echo "==> Baixando Node.js v${VERSION} (${ARCH})"
curl -fsSL -o "$WORK_DIR/$TARBALL" "$BASE/$TARBALL"
curl -fsSL -o "$WORK_DIR/SHASUMS256.txt" "$BASE/SHASUMS256.txt"

echo "==> Verificando checksum oficial"
(
  cd "$WORK_DIR"
  grep " ${TARBALL}\$" SHASUMS256.txt | sha256sum -c -
)

sudo mkdir -p "$ROOT"

if [[ -d "$FINAL_PATH" ]]; then
  # Idempotência: nunca sobrescreve uma instalação existente. Se ela estiver
  # saudável, reaproveita; se não, ABORTA sem tocar em nada.
  if [[ -x "$FINAL_PATH/bin/node" ]] && "$FINAL_PATH/bin/node" --version 2>/dev/null | grep -qx "v${VERSION}"; then
    echo "==> Node.js v${VERSION} já instalado em ${FINAL_PATH} (reaproveitando)"
  else
    echo "ERRO: ${FINAL_PATH} existe mas não responde com v${VERSION}." >&2
    echo "      Nada foi alterado. Remova o diretório manualmente e rode de novo." >&2
    exit 1
  fi
else
  echo "==> Extraindo em staging (${ROOT})"
  STAGING="$(sudo mktemp -d "${ROOT}/.staging-${VERSION}-XXXXXX")"
  sudo tar -xJf "$WORK_DIR/$TARBALL" -C "$STAGING"
  sudo chown -R root:root "$STAGING"

  # Verifica o binário ANTES de publicar qualquer coisa.
  #
  # ATENÇÃO: o staging é criado por `sudo mktemp -d` e fica root:root 0700 de
  # propósito (isolamento durante a extração). O usuário que roda este script
  # não consegue ATRAVESSAR esse diretório: executar o binário direto daqui
  # falha com "Permission denied". Por isso a validação roda sob sudo - o
  # diretório NÃO é aberto para todos.
  if ! sudo "$STAGING/$EXTRACTED/bin/node" --version | grep -qx "v${VERSION}"; then
    echo "ERRO: o binário extraído não respondeu com v${VERSION}. Symlink NÃO alterado." >&2
    exit 1
  fi
  if ! sudo test -x "$STAGING/$EXTRACTED/bin/npm"; then
    echo "ERRO: npm não encontrado no runtime extraído. Symlink NÃO alterado." >&2
    exit 1
  fi

  # Rename no MESMO filesystem: ou o diretório final aparece completo, ou não.
  sudo mv "$STAGING/$EXTRACTED" "$FINAL_PATH"
  sudo rm -rf "$STAGING"
  STAGING=""
fi

# Alvo anterior (para restauração se a verificação final falhar).
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$CURRENT_LINK" || true)"
fi

echo "==> Trocando ${CURRENT_LINK} de forma atômica"
# Remove resto de uma execução anterior que tenha falhado no meio (se por acaso
# virou diretório, `ln` criaria o link DENTRO dele).
sudo rm -rf "${ROOT}/.current.tmp"
sudo ln -sfn "$FINAL_PATH" "${ROOT}/.current.tmp"
sudo mv -Tf "${ROOT}/.current.tmp" "$CURRENT_LINK"

# Confirma que o symlink publicado aponta para um runtime funcional.
INSTALLED_VERSION="$("$CURRENT_LINK/bin/node" --version 2>/dev/null || true)"
if [[ "$INSTALLED_VERSION" != "v${VERSION}" ]]; then
  echo "ERRO: ${CURRENT_LINK} não respondeu com v${VERSION} (obtido: '${INSTALLED_VERSION}')." >&2
  if [[ -n "$PREVIOUS_TARGET" ]]; then
    sudo ln -sfn "$PREVIOUS_TARGET" "${ROOT}/.current.tmp"
    sudo mv -Tf "${ROOT}/.current.tmp" "$CURRENT_LINK"
    echo "      Symlink anterior restaurado: ${PREVIOUS_TARGET}" >&2
  else
    sudo rm -f "$CURRENT_LINK"
    echo "      Nenhum symlink anterior: current removido." >&2
  fi
  exit 1
fi

echo
echo "Runtime disponível em: ${CURRENT_LINK}/bin/node"
"$CURRENT_LINK/bin/node" --version
"$CURRENT_LINK/bin/npm" --version
echo
echo "O /usr/bin/node NÃO foi alterado. Run antigos continuam em ${ROOT}/node-v*."
echo "Para o Core usar este runtime (detecção automática no ecosystem):"
echo "  cd <repo> && pm2 restart ecosystem.config.js --update-env && pm2 save"
echo "Rollback: KORRELO_NODE_BIN=\"\$(command -v node)\" pm2 restart ecosystem.config.js --update-env"
echo "          (ou remova o symlink ${CURRENT_LINK})"
