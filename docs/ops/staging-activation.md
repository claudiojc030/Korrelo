# Rollout B — ativar o staging isolado (somente após capacidade comprovada)

Pré-condição absoluta: `docs/ops/rollout-core-update.md` concluído e
`stagingActivation.verdict = GO` na auditoria de capacidade.

A atualização do Core **não** ativa o staging. Esta etapa é separada e reversível.

## 1. Preparação

- [ ] Auditoria de capacidade recente (mesmo dia) e anexada ao relatório.
- [ ] Janela fora de pico; ninguém operando Mesatta no momento.
- [ ] Backup verificado do SQLite.
- [ ] Configuração de staging do projeto criada **antes** (via CLI local, token 0600), com
      `mode=isolated`, `allowEgress=false`, `ttlMinutes` curto (20–30), app 1024 MB, Mongo 384 MB.
- [ ] Imagem do Mesatta carregada com o ID homologado (`06c3cce5…`) e `image:verify` OK.
- [ ] Confirmar que a flag está **ausente/false** e que nenhum run está preso.

## 2. Ativação

1. Definir `KORRELO_STAGING_ISOLATED_EXECUTION=true` **somente no serviço do Core**.
2. Reiniciar apenas o Core.
3. Confirmar no boot: scheduler de recuperação roda (log `[staging-recovery]`) e não altera nada.
4. Disparar **um** deploy de validação (staging-only) num projeto de teste, em horário controlado.
5. Observar durante o run:
   - `docker stats` do app e do Mongo;
   - `memory.peak` dos containers;
   - logs por estágio (`staging-health`, `promote`, `production-health`, `rollback`);
   - nenhum `OOMKilled`, nenhum restart.
6. Ao final: containers/redes/volumes do run removidos; produção do projeto intacta (`currentImage` inalterado).
7. Repetir a auditoria de capacidade **durante** o run (segunda coleta) para comparar com o regime.

## 3. Critérios de aborto (desligar a flag imediatamente)

- qualquer container da produção do Mesatta mudar de imagem/ID/estado;
- `OOMKilled=true`, `ExitCode=134` ou restart inesperado;
- `MemAvailable` abaixo de 512 MB no host;
- PSI memória `full avg10` acima de 10% por mais de 1 minuto;
- run não limpar os próprios recursos;
- qualquer deploy promovido sem healthcheck.

Abortar = parar o Core, remover a flag, reiniciar o Core. Não apagar a configuração de staging nem imagens.

## 4. Evidências a registrar

- run id / job id, imagem e commit, duração, `docker stats` (antes/durante/depois), `memory.peak`;
- imagem antes/depois (deve ser a mesma);
- resultado do cleanup (0 containers, redes só padrão);
- auditoria de capacidade antes e durante.

## 5. GO/NO-GO da ativação

GO: run de validação completo, sem aborto, cleanup OK, produção intacta, capacidade `GO` nas duas coletas.
NO-GO: qualquer critério de aborto, ou capacidade `NO-GO`.

Se `stagingActivation.verdict = NO-GO`: **não ativar**; manter homologação no laboratório privado.
