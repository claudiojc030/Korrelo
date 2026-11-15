# Korrelo — Laboratório de staging isolado

Repositório **descartável** de validação do MVP de staging isolado do Korrelo.

- Código copiado do repositório principal (planner, compose, executor, runtime
  Docker/Compose, `WorkerLock`, verificador de imagem, repositórios Prisma).
- Nenhum endpoint, webhook, runner self-hosted, registry ou deploy.
- Nenhum segredo: o workflow usa apenas variáveis padrão do GitHub. As
  credenciais do MongoDB efêmero são geradas por execução.
- Execução manual (`workflow_dispatch`), permissão `contents: read`.
- Todo recurso Docker criado é efêmero, loopback e removido no próprio run.

## Escopo

O harness executa o código real com:

- `PrismaStagingRunRepository` e `PrismaStagingPortLeaseRepository` sobre
  SQLite temporário (`prisma db push`);
- `StagingExecutionService` e `DockerComposeStagingRuntime` reais;
- imagem pré-construída e healthcheck HTTP no IP do container;
- MongoDB 7 efêmero com credenciais aleatórias, rede e volume exclusivos;
- aplicação sintética que conecta, grava e lê no MongoDB temporário.

Cenários: staging sem banco, imagem ausente/divergente, porta ocupada,
capacidade insuficiente, health reprovado, falha de criação rastreável,
concorrência de reserva, ownership divergente, recuperação após SIGKILL,
MongoDB efêmero, falha do MongoDB, `MONGODB_URL` ausente e preservação de
recursos externos.

## Limitações conhecidas

- A recuperação após crash usa o run persistido no SQLite e o cleanup escopado,
  não o job de reconciliação do Core.
- A sonda HTTP usa o IP do container; portas publicadas em `127.0.0.1` podem
  não ser alcançáveis no host do runner.
- Apenas MongoDB efêmero é suportado no deploy isolado nesta fase.
- Nenhum teste toca a VPS, o Mesatta, a Evolution API ou produção.
