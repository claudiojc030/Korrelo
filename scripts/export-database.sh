#!/usr/bin/env bash
# Disparado pelo botão "Exportar banco antes de apagar" na exclusão de um
# projeto (ver ScriptDatabaseExporter / StartDatabaseExportUseCase). Recebe
# CONTAINER_NAME, DB_TYPE, DB_USERNAME, DB_PASSWORD, DB_NAME e OUT_FILE por
# variável de ambiente, não por argumento, pra não deixar credenciais
# visíveis em "ps aux".
set -uo pipefail

step() {
  echo "__KORRELO_DBEXPORT_STEP__|$1|$2"
}

fail() {
  echo "__KORRELO_DBEXPORT_DONE__|failed|$1"
  exit 1
}

: "${CONTAINER_NAME:?}"
: "${DB_TYPE:?}"
: "${OUT_FILE:?}"

mkdir -p "$(dirname "$OUT_FILE")"

step 10 "Exportando banco de dados"
case "$DB_TYPE" in
  postgres)
    docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USERNAME" "$DB_NAME" > "$OUT_FILE" || fail "Falha ao exportar o Postgres."
    ;;
  mongodb)
    docker exec "$CONTAINER_NAME" mongodump --username "$DB_USERNAME" --password "$DB_PASSWORD" --authenticationDatabase admin --archive > "$OUT_FILE" || fail "Falha ao exportar o MongoDB."
    ;;
  redis)
    docker exec "$CONTAINER_NAME" redis-cli -a "$DB_PASSWORD" SAVE > /dev/null 2>&1 || fail "Falha ao salvar o RDB do Redis."
    docker cp "$CONTAINER_NAME:/data/dump.rdb" "$OUT_FILE" || fail "Falha ao copiar o dump do Redis."
    ;;
  *)
    fail "Tipo de banco não suportado pra exportação: $DB_TYPE"
    ;;
esac

step 80 "Enviando pro armazenamento externo (se configurado)"
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT_FILE" "${BACKUP_RCLONE_REMOTE}:korrelo-backups/exports/" \
    || echo "Aviso: falha ao enviar pro remote rclone, o arquivo continua disponível pra download."
fi

step 100 "Exportação concluída"
echo "__KORRELO_DBEXPORT_DONE__|success"
