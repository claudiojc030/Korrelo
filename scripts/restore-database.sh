#!/usr/bin/env bash
# Disparado pelo botão "Restaurar" na aba Banco de Dados do projeto (ver
# ScriptDatabaseRestorer / StartDatabaseRestoreUseCase). Recebe CONTAINER_NAME,
# DB_TYPE, DB_USERNAME, DB_PASSWORD, DB_NAME e IN_FILE por variável de
# ambiente, não por argumento, pra não deixar credenciais visíveis em "ps aux".
#
# DESTRUTIVO: substitui todo o conteúdo atual do banco pelo do backup.
# Por isso o motor (scripts/backup-lib/restore-cli.cjs) só chega no
# `--drop`/`DROP SCHEMA` depois de validar o arquivo (tamanho + sha256) e de
# criar um backup de segurança do estado atual - se esse backup falhar, o
# restore é abortado sem tocar no banco.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${CONTAINER_NAME:-}" ] || [ -z "${DB_TYPE:-}" ] || [ -z "${IN_FILE:-}" ]; then
  echo "__KORRELO_DBRESTORE_DONE__|failed|Variáveis obrigatórias ausentes (CONTAINER_NAME, DB_TYPE, IN_FILE)."
  exit 1
fi

exec node "$SCRIPT_DIR/backup-lib/restore-cli.cjs"
