#!/usr/bin/env bash
# Disparado pelo botão "Importar de outro MongoDB" na aba Banco de Dados do
# projeto (ver ScriptMongoImporter / StartMongoImportUseCase). Recebe
# SOURCE_URI, TARGET_URI e CONTAINER_NAME por variável de ambiente, não por
# argumento de linha de comando, pra não deixar as connection strings
# visíveis em "ps aux".
set -uo pipefail

step() {
  echo "__KORRELO_MONGOIMPORT_STEP__|$1|$2"
}

fail() {
  echo "__KORRELO_MONGOIMPORT_DONE__|failed|$1"
  rm -f "$DUMP_FILE"
  exit 1
}

: "${SOURCE_URI:?}"
: "${TARGET_URI:?}"
: "${CONTAINER_NAME:?}"
: "${SOURCE_DB:?}"
: "${TARGET_DB:?}"

DUMP_FILE="/tmp/korrelo-mongo-import-$$.archive"

step 5 "Verificando ferramentas do MongoDB"
if ! command -v mongodump &> /dev/null || ! command -v mongorestore &> /dev/null; then
  fail "mongodump/mongorestore não estão instalados nesta VPS. Rode 'bash scripts/setup-vps.sh' de novo (instala só o que falta) e tente de novo."
fi

step 15 "Exportando dados do MongoDB de origem"
# --db limita o dump a UM banco (o da connection string informada). Sem
# isso, uma connection string sem nome de banco no path baixava o cluster
# inteiro, e o restore recriava cada banco com o nome ORIGINAL - nunca no
# banco do projeto de verdade.
mongodump --uri="$SOURCE_URI" --db="$SOURCE_DB" --archive="$DUMP_FILE" --quiet \
  || fail "Não foi possível conectar ou exportar do MongoDB de origem. Verifique a connection string."

step 70 "Importando dados para o banco do projeto"
# --nsFrom/--nsTo remapeia o banco de origem pro banco do projeto mesmo que
# tenham nomes diferentes (o dump preserva o nome original de origem).
docker exec -i "$CONTAINER_NAME" mongorestore --uri="$TARGET_URI" --archive --drop \
  --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*" --quiet < "$DUMP_FILE" \
  || fail "Não foi possível importar os dados para o banco do projeto."

step 95 "Limpando arquivos temporários"
rm -f "$DUMP_FILE"

step 100 "Importação concluída"
echo "__KORRELO_MONGOIMPORT_DONE__|success"
