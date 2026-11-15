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

- O adaptador de repositório não reproduz a transação Prisma de reserva.
- A recuperação após crash usa o registro persistido em JSON, não
  `PrismaStagingRunRepository.recoverRun`.
- Bancos temporários são validados quanto a ciclo de vida (subir/limpar), não
  quanto a conectividade da aplicação.
- Nenhum teste toca a VPS, o Mesatta, a Evolution API ou produção.
