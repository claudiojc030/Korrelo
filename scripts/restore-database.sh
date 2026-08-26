#!/usr/bin/env bash
# Disparado pelo botão "Restaurar" na aba Banco de Dados do projeto (ver
# ScriptDatabaseRestorer / StartDatabaseRestoreUseCase). Recebe CONTAINER_NAME,
# DB_TYPE, DB_USERNAME, DB_PASSWORD, DB_NAME e IN_FILE por variável de
# ambiente, não por argumento, pra não deixar credenciais visíveis em "ps aux".
#
# DESTRUTIVO: substitui todo o conteúdo atual do banco pelo do backup.
set -uo pipefail

step() {
  echo "__KORRELO_DBRESTORE_STEP__|$1|$2"
}

fail() {
  echo "__KORRELO_DBRESTORE_DONE__|failed|$1"
  exit 1
}

: "${CONTAINER_NAME:?}"
: "${DB_TYPE:?}"
: "${IN_FILE:?}"

[ -f "$IN_FILE" ] || fail "Arquivo de backup não encontrado: $IN_FILE"

step 10 "Restaurando banco de dados"
case "$DB_TYPE" in
  postgres)
    # Schema limpo antes de restaurar: o dump (pg_dump sem --clean) só tem
    # CREATE TABLE/INSERT, sem DROP - sem isso, restaurar por cima de tabelas
    # já existentes falha com "already exists" na primeira linha.
    docker exec "$CONTAINER_NAME" psql -U "$DB_USERNAME" -d "$DB_NAME" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
      || fail "Falha ao limpar o schema do Postgres antes de restaurar."
    docker exec -i "$CONTAINER_NAME" psql -U "$DB_USERNAME" -d "$DB_NAME" < "$IN_FILE" \
      || fail "Falha ao restaurar o dump no Postgres."
    ;;
  mongodb)
    # --drop: cada coleção do backup substitui a coleção atual de mesmo nome
    # (coleções que só existem no banco atual, fora do backup, não são tocadas).
    docker exec -i "$CONTAINER_NAME" mongorestore --username "$DB_USERNAME" --password "$DB_PASSWORD" --authenticationDatabase admin --archive --drop < "$IN_FILE" \
      || fail "Falha ao restaurar o backup no MongoDB."
    ;;
  redis)
    docker cp "$IN_FILE" "$CONTAINER_NAME:/data/dump.rdb" || fail "Falha ao copiar o RDB pro container."
    # Redis só carrega o RDB do disco na inicialização - reinicia o processo
    # pra recarregar (o container continua de pé, "restart: unless-stopped"
    # no compose sobe o redis-server de novo sozinho).
    docker restart "$CONTAINER_NAME" || fail "Falha ao reiniciar o Redis pra recarregar o RDB restaurado."
    ;;
  *)
    fail "Tipo de banco não suportado pra restauração: $DB_TYPE"
    ;;
esac

step 100 "Restauração concluída"
echo "__KORRELO_DBRESTORE_DONE__|success"
