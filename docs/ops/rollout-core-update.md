# Rollout A — atualizar o Core com staging DESLIGADO

Objetivo: subir o Korrelo candidato `b81cc154…` com `KORRELO_STAGING_ISOLATED_EXECUTION` **ausente ou
`false`**, sem ligar staging, sem tocar em Mesatta/Evolution.

## Fatos verificados no código

- `staging-execution.service.ts:40`, `staging-deploy-integration.service.ts:73` e
  `staging-run-recovery.scheduler.ts:33` só habilitam com `process.env.KORRELO_STAGING_ISOLATED_EXECUTION === "true"`.
  Ausente = desligado; `"1"`/`"TRUE"` **não** ligam.
- Sem configuração persistida em `ProjectStagingConfig`, `prepare()` retorna `mode: "legacy"` e não executa nada.
- Configuração isolada com a flag desligada retorna `ok=false` ("não está habilitado") e **não** cai para o
  staging legado (teste `staging-deploy-integration.service.spec.ts`).
- Migrations de staging são estritamente aditivas (criam tabelas; nada em `Project`).
- Deploy de produção continua com os gates antigos: ID verificado, health, rollback por `previousImage`,
  lock de deploy por projeto.

## Pré-requisitos

- [ ] Capacidade avaliada com `scripts/ops/vps-capacity-audit.mjs` e `coreUpdate.verdict = GO`.
- [ ] Backup do SQLite criado e verificado (`docs/ops/sqlite-backup-restore.md`).
- [ ] Confirmar que `KORRELO_STAGING_ISOLATED_EXECUTION` **não** está no ambiente do serviço
      (`systemctl show -p Environment korrelo` / unit file) — se estiver `true`, remover antes.
- [ ] `autoDeployEnabled=false` nos projetos ou fila de deploy pausada durante a janela.
- [ ] Registrar SHA atual do Core em produção (`2390439`) e a imagem/tag em uso.
- [ ] Anotar estado de Mesatta/Evolution (`docker ps`, health) **antes**.

## Passos

1. Parar apenas o Core do Korrelo (nunca `docker stop` em Mesatta/Evolution):
   `systemctl stop korrelo` (ou o mecanismo do self-update/deploy usado pela instalação).
2. Publicar o código/imagem do commit `b81cc154…` (mesmo procedimento atual de atualização).
3. Migrations (aditivas) com o Core parado:
   `cd apps/api && npx prisma migrate deploy` → deve aplicar **3** novas (31 no total) e sair 0.
4. Subir o Core **sem** a flag (ou com `false`). Confirmar:
   - `GET /health` OK; login admin OK;
   - `GET /monitoring/system` responde (Docker acessível);
   - `KORRELO_STAGING_ISOLATED_EXECUTION` ausente/false no processo.
5. Verificar que nenhum projeto foi deployado automaticamente: nenhum `DeployJob` novo, nenhum container
   recriado além do Core.
6. Confirmar Mesatta/Evolution: mesmos containers, mesmos IDs, health igual ao registrado antes.
7. Registrar evidência: SHA de código, contagem de migrations, horários, saída de `docker ps`.

## Abortar imediatamente se

- `migrate deploy` falhar ou aplicar contagem diferente de 3;
- health do Core não voltar;
- qualquer container de Mesatta/Evolution mudar de ID/imagem/estado;
- `stagingActivation` estiver ligado por engano (flag presente como `true`);
- aparecer deploy de projeto não solicitado.

## Rollback do Core (sem tocar em Mesatta/Evolution)

1. Parar o Core.
2. Restaurar a versão anterior do código/imagem (`2390439`).
3. Restaurar o SQLite do backup (opcional: só se houver divergência de schema/dados; as tabelas novas são
   ignoradas pelo código antigo).
4. Subir o Core, validar `/health` e login.
5. Confirmar Mesatta/Evolution intactos.

## GO/NO-GO do rollout A

GO: todos os pré-requisitos + passos 1–7 registrados.
NO-GO: qualquer item de aborto, ou capacidade `coreUpdate.verdict != GO`.
