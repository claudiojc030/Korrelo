# Auditoria de capacidade da VPS (somente leitura)

Ferramenta: `scripts/ops/vps-capacity-audit.mjs` (+ lógica em `scripts/ops/lib/capacity-evaluate.mjs`).
Não precisa do Core atualizado, de banco, nem de `npm install`: Node >= 20 e acesso de leitura ao Docker.

## Por que não usar só o painel

O Core já expõe `GET /monitoring/system` (CPU, memória total/livre, disco, containers via `docker stats`) e
`GET /monitoring/storage`. Isso **não cobre** o que a decisão de rollout exige: `MemAvailable`, swap,
PSI (pressão), inodes, eventos de OOM do kernel, `RestartCount`/`OOMKilled`, cache BuildKit e reserva de
disco para duas imagens. Além disso, exige o Core atualizado e autenticado — o script funciona antes.

## Garantias de segurança

- Allowlist de binários e subcomandos; `assertReadOnlyCommand` recusa mutantes (`rm`, `stop`, `restart`,
  `prune`, `run`, `build`, `exec`, `compose`, `volume rm`, ...).
- Nenhuma leitura de `.env`, `Config.Env` ou cmdline de processos.
- Saída apenas em stdout; o script não grava arquivo.
- Não altera containers, imagens, serviços, bancos ou configuração.

## Como executar (operador autorizado)

```bash
# 1. copie os dois arquivos para o host (mesmo diretório relativo)
#    scripts/ops/vps-capacity-audit.mjs
#    scripts/ops/lib/capacity-evaluate.mjs

# 2. confira a allowlist antes de rodar
node scripts/ops/vps-capacity-audit.mjs --self-check

# 3. coleta (JSON estruturado) — redirecione você mesmo para um arquivo
node scripts/ops/vps-capacity-audit.mjs > capacidade-vps.json

# 4. versão legível para revisão rápida
node scripts/ops/vps-capacity-audit.mjs --text
```

Para acessar `journalctl -k`/`dmesg` (contagem de OOM), o usuário precisa de permissão de leitura do log do
kernel. Sem isso, `oom.events24h` fica `null` e os gates **reprovam** — de propósito, não é "zero".

## Saída

JSON com `collectedAt`, `host`, `memory`, `psi`, `oom`, `disk`, `docker` (containers com limite, restarts,
OOM, health) e `evaluation`:

- `coreUpdate.verdict`: pode atualizar o Core com staging desligado;
- `stagingActivation.verdict`: pode ligar `KORRELO_STAGING_ISOLATED_EXECUTION`;
- cada check traz `id`, `ok`, `value`, `threshold`.

Reavaliar offline sem recoletar: `--fixture capacidade-vps.json`.
Falhar o processo quando o staging não estiver aprovado: `--fail-on-no-go`.

## Limiares (editáveis em `lib/capacity-evaluate.mjs`)

| Gate | Limiar |
|---|---|
| RAM disponível para staging | >= 2560 MB |
| Margem após reservar 1024 MB (app) + 384 MB (Mongo) + 512 MB (overhead) | >= 0 |
| RAM disponível para atualizar o Core | >= 1024 MB |
| PSI memória `full avg10` | <= 1% |
| Load (5 min) por CPU | <= 0.6 |
| Disco livre no FS do Docker | >= 10 GB (staging) / 3 GB (Core) |
| Reserva extra para imagem atual + rollback | +1.5 GB |
| Inodes livres | >= 100k e >= 20% |
| Eventos de OOM (24h) | 0 |
| Containers com `OOMKilled=true` / `unhealthy` | 0 |

## Relatório seguro

Use `docs/ops/report-template.md`. Não inclua `.env`, tokens, URLs com credenciais nem cmdlines.
