#!/usr/bin/env bash
# Disparado pelo botão "Exportar banco antes de apagar" na exclusão de um
# projeto (ver ScriptDatabaseExporter / StartDatabaseExportUseCase) e pelo
# backup manual do projeto (ver StartProjectBackupUseCase). Recebe
# CONTAINER_NAME, DB_TYPE, DB_USERNAME, DB_PASSWORD, DB_NAME e OUT_FILE por
# variável de ambiente, não por argumento, pra não deixar credenciais
# visíveis em "ps aux".
#
# O trabalho pesado é feito pelo motor único (scripts/backup-lib/dump-cli.cjs):
# stdout do dump vai direto pro arquivo (sem Buffer na RAM), o arquivo final
# só aparece depois de tudo dar certo (temp + rename), e ainda gera sha256 +
# manifesto, lock por banco e preflight de disco. Este script só mantém o
# contrato de marcadores com o painel.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${CONTAINER_NAME:-}" ] || [ -z "${DB_TYPE:-}" ] || [ -z "${OUT_FILE:-}" ]; then
  echo "__KORRELO_DBEXPORT_DONE__|failed|Variáveis obrigatórias ausentes (CONTAINER_NAME, DB_TYPE, OUT_FILE)."
  exit 1
fi

exec node "$SCRIPT_DIR/backup-lib/dump-cli.cjs"
