# Backup, verificação e restauração do SQLite do Korrelo

Ferramentas:

- `scripts/ops/korrelo-sqlite-backup.mjs` — `path`, `verify`, `backup`, `restore`.
- `scripts/ops/lib/sqlite-core.mjs` — núcleo (backup online via `node:sqlite.backup`).
- `scripts/ops/sqlite-restore-drill.mjs` — ensaio completo descartável.

Regras: origem sempre **somente leitura**; destino nunca é sobrescrito sem `--force`; nada toca containers,
serviços ou outros bancos.

## Requisito de runtime

`node:sqlite` existe no Node 22.5+ (experimental) e no Node 24+. No Node 22 use `--experimental-sqlite`.
Alternativa manual equivalente: `sqlite3 <db> ".backup '<saida>'"` (>= 3.27), que é a mesma API de backup
online do SQLite usada pelo script.

## Identificar o banco

```bash
node scripts/ops/korrelo-sqlite-backup.mjs path
```

Mostra candidatos (`KORRELO_DB_PATH`, `DATABASE_URL=file:…`, `/var/lib/korrelo/korrelo.db`, ...) com
`exists`/`bytes`, **sem abrir** o arquivo. Se o caminho real for outro, passe `--db` explicitamente.

## Backup consistente

```bash
node --experimental-sqlite scripts/ops/korrelo-sqlite-backup.mjs backup \
  --db /var/lib/korrelo/korrelo.db \
  --out /root/backup/korrelo-$(date +%F-%H%M).db
```

Usa a API de backup online (consistente com WAL e conexões ativas) e, ao final, roda
`integrity_check`, `quick_check` e `foreign_key_check` no arquivo gerado. Falha se o backup não for íntegro.

Guardar: caminho, tamanho e SHA-256 do arquivo (o JSON de saída não inclui hash; use `sha256sum`).

## Verificar

```bash
node --experimental-sqlite scripts/ops/korrelo-sqlite-backup.mjs verify --db <arquivo>
```

Retorna `ok`, `issues`, `tables`, `migrations`, `bytes`, `journal_mode`.

## Restaurar (apenas em cópia / fora de produção)

```bash
node --experimental-sqlite scripts/ops/korrelo-sqlite-backup.mjs restore \
  --backup /root/backup/korrelo-XXXX.db \
  --to /tmp/drill/korrelo.db
```

Verifica o backup antes de copiar e valida o destino depois. `--to` existente exige `--force`.

## Ensaio completo (backup → 3 migrations → falha → restore)

```bash
node scripts/ops/sqlite-restore-drill.mjs --migrations apps/api/prisma/migrations
```

O que ele prova, em diretório temporário:

1. banco "de produção" com todas as migrations exceto as três de staging (28 de 31);
2. backup online + integridade;
3. as três migrations de staging aplicadas **somente na cópia**;
4. nenhuma coluna/tabela anterior removida e dados preservados;
5. corrupção da cópia detectada;
6. restauração do backup íntegra, de volta ao schema anterior;
7. consulta legada (`SELECT id,name,repoUrl,status FROM Project`) funciona após restaurar;
8. banco de origem com o mesmo SHA-256 no início e no fim.

Saída: `drill-report.json` em `--workdir` com todos os checks e `verdict`.

## Condições para uma restauração em produção

Só executar com **todos** verdadeiros:

- janela autorizada e responsável presente;
- Core parado (ou em modo somente leitura) para evitar escrita concorrente;
- backup verificado (`ok=true`) e hash registrado;
- rollback do código definido (imagem/tag anterior do Core);
- containers Mesatta/Evolution intocados e saudáveis antes e depois;
- após restaurar: `integrity_check=ok`, contagem de `_prisma_migrations` igual à esperada, login admin OK.

Fora dessas condições, restaurar apenas em cópia descartável.
