#!/usr/bin/env bash
# Confere o runtime do Core. Somente leitura: não instala nem reinicia nada.
#
# POLÍTICA (mesma do campo "engines" nos package.json):
#   linha 22 -> >= 22.23.4 (corrigida do CVE-2026-111497)
#   linha 24 -> >= 24.22.1
#   linha 26 -> >= 26.12.1
# Qualquer outra linha (20, 23, 25, 27+) é recusada: 20 e as ímpares estão EOL
# e versões abaixo do patch mínimo da própria linha continuam vulneráveis.
#
# Uso:
#   bash scripts/check-runtime.sh
#   KORRELO_NODE_BIN=/opt/korrelo/node/current/bin/node bash scripts/check-runtime.sh
#
# Sai com código != 0 quando o runtime não atende à política.
set -euo pipefail

NODE_BIN="${KORRELO_NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "FALHOU: node não encontrado (KORRELO_NODE_BIN='${KORRELO_NODE_BIN:-}')" >&2
  exit 1
fi

VERSION="$("$NODE_BIN" -p 'process.versions.node')"
echo "node: ${VERSION} (${NODE_BIN})"
# npm do MESMO runtime quando existir ao lado do binário (caso do install
# lado a lado em /opt/korrelo/node/<versao>/bin/npm).
NODE_DIR="$(dirname "$NODE_BIN")"
if [[ -x "${NODE_DIR}/npm" ]]; then
  echo "npm:  $("${NODE_DIR}/npm" -v)"
elif command -v npm >/dev/null 2>&1; then
  echo "npm:  $(npm -v) (do PATH)"
fi
if command -v pm2 >/dev/null 2>&1; then echo "pm2:  $(pm2 -v 2>/dev/null || echo '?')"; fi

if "$NODE_BIN" -e '
const MIN = { "22": [22, 23, 4], "24": [24, 22, 1], "26": [26, 12, 1] };
const cur = process.versions.node.split(".").map(Number);
const min = MIN[String(cur[0])];
if (!min) {
  console.error("LINHA NAO SUPORTADA: " + process.versions.node +
    " (use 22.23.4+, 24.22.1+ ou 26.12.1+)");
  process.exit(1);
}
for (let i = 0; i < 3; i++) {
  if (cur[i] > min[i]) process.exit(0);
  if (cur[i] < min[i]) {
    console.error("Abaixo do patch minimo da linha " + cur[0] + ": " +
      process.versions.node + " < " + min.join("."));
    process.exit(1);
  }
}
process.exit(0);
'; then
  echo "OK: runtime corrigido para a linha em uso"
else
  echo "FALHOU: runtime fora da politica. Veja docs/security/node22-migration.md" >&2
  exit 1
fi
