# Korrelo — Laboratório de staging isolado

Repositório **descartável** de validação do MVP de staging isolado do Korrelo.

- Código copiado do repositório principal do Korrelo (planner, compose, executor,
  runtime Docker/Compose, `WorkerLock`, verificador de imagem pré-construída).
- Nenhum endpoint, webhook, runner self-hosted, registry ou deploy.
- Nenhum segredo: o workflow usa apenas as variáveis padrão do GitHub.
- Execução manual (`workflow_dispatch`), permissão `contents: read`.
- Todo recurso Docker criado é efêmero, loopback e removido no próprio run.

## Escopo

O harness (`test/staging-lab/harness.ts`) executa o executor real com um
adaptador de repositório de teste (o repositório real é Prisma/SQLite). São
validados: staging sem banco, imagem pré-construída, imagem ausente, identidade
divergente, porta ocupada, capacidade insuficiente, healthcheck reprovado,
falha na criação, ownership divergente, recuperação após crash, MongoDB e
PostgreSQL temporários e ausência de mudanças fora do staging.

## Limitações conhecidas

- O adaptador de repositório do harness é JSON; a integração Prisma real é
  coberta por testes na API (`staging-execution-prisma.integration.spec.ts`)
  com SQLite temporário e runtime fake.
- A recuperação após crash usa o registro persistido em JSON, não
  `PrismaStagingRunRepository.recoverRun`.
- O gate de deploy isolado (`StagingDeployIntegrationService`) é coberto por
  testes unitários; não é exercitado por este harness.
- Bancos temporários são validados quanto a ciclo de vida (subir/limpar), não
  quanto a conectividade da aplicação.
- A sonda HTTP usa o IP do container na rede interna; portas publicadas em
  127.0.0.1 podem não ser alcançáveis no host do runner.
- Nenhum teste toca a VPS, o Mesatta, a Evolution API ou produção.
