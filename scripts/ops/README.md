# Ferramentas de operação (somente leitura)

| Ferramenta | Para que serve | Escreve? |
|---|---|---|
| `vps-capacity-audit.mjs` | Coleta CPU/RAM/PSI/disco/inodes/OOM/Docker e emite GO/NO-GO para (A) atualizar o Core e (B) ativar staging | Não. Só stdout |
| `lib/capacity-evaluate.mjs` | Lógica pura dos gates (testável sem host) | Não |
| `korrelo-sqlite-backup.mjs` | `path`, `verify`, `backup`, `restore` do SQLite; origem sempre read-only | Só no `--out`/`--to` |
| `lib/sqlite-core.mjs` | Núcleo de backup online + verificação de integridade | Só no destino |
| `sqlite-restore-drill.mjs` | Ensaio backup → 3 migrations → falha → restore, tudo descartável | Só no `--workdir` |

## Testes

```bash
node --test scripts/ops/tests/capacity.test.mjs
node scripts/ops/sqlite-restore-drill.mjs --migrations apps/api/prisma/migrations
```

Os testes não usam rede, Docker real, banco de produção nem credenciais. A coleta real
(`vps-capacity-audit.mjs` sem `--fixture`) é para ser executada pelo operador autorizado no host, nunca
por automação sem supervisão.

## Documentos

- `docs/ops/vps-capacity-audit.md`
- `docs/ops/sqlite-backup-restore.md`
- `docs/ops/rollout-core-update.md` (A)
- `docs/ops/staging-activation.md` (B)
- `docs/ops/report-template.md`
