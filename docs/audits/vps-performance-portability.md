# Auditoria de desempenho, consumo de recursos e portabilidade do Korrelo

**Data:** 20/10/2026 · **Base:** `main @ 94b0e98` (código publicado) · **Natureza:** READ-ONLY (diagnóstico + propostas; **nenhuma otimização estrutural foi implementada**)

Contexto de referência da VPS auditada: **1 vCPU · 3915 MB RAM · 2047 MB swap · ~26.9 GB disco livre**, hospedando Mesatta (app + Mongo), Evolution API (app + Postgres + Redis) e o próprio Korrelo (API + Web).

---

## 1. Resumo executivo

O Korrelo **não tem assumptions rígidas de hardware no runtime do Core**: os limites de memória de projeto são observados (grandfathering) e o build do Core é protegido por resource guard + cooldown. O que **existe** são assumptions implícitas concentradas em quatro pontos:

1. **Build local do Core na VPS** — consome até ~1 GB de heap e 1 vCPU inteira durante ~2-5 min. É o maior consumidor transitório da máquina e o único que pode ser movido para fora.
2. **Escala de polling** — o dashboard e a coleta de métricas fazem chamadas ao Docker periodicamente (60 s no backend, 30 s no frontend). Em VPS pequena isso é ruído constante em CPU e I/O.
3. **Crescimento de armazenamento** — `DeployRecord.log` (texto livre), amostras de métrica (7 dias) e logs do PM2/Docker **não têm teto de tamanho** no Core.
4. **Portabilidade** — o rollout depende de `bash`, `sqlite3` CLI, `nice`/`ionice`, `/proc`, `free`, `df`, `git`, `npm` e `node` presentes. A maioria é opcional (há fallback), mas `sqlite3` CLI é **REQUIRED** no backup do Core.

**Veredito:** o Core em si roda confortavelmente a partir de **1 GB** (com 2 processos Node de 192 MB de heap). O que não cabe em 1 GB é o **build do próprio Core** — e é exatamente o que a auditoria recomenda mover para fora da VPS (ou para uma máquina maior).

---

## 2. Maiores gargalos atuais

| # | Gargalo | Onde | Evidência |
|---|---|---|---|
| G1 | **Build do Core na VPS** | `scripts/rollout-korrelo.sh` → `npm ci --include=dev` + 3 builds | heap 1024 MB + 1 vCPU; já houve incidente de pressão |
| G2 | **`docker ps` + `docker stats` a cada 60 s** | `os-system-metrics-collector.ts` (linhas 133/141) | 2 processos Docker por minuto, sempre |
| G3 | **`docker ps` por chamada** em alocação de porta e preflight | `port-allocator.ts:44`, `resource-preflight.service.ts:187` | sem cache; N chamadas = N processos |
| G4 | **`DeployRecord.log` sem teto** | `schema.prisma` (`log String @default("")`) | texto livre por deploy, cresce sem limite |
| G5 | **Logs do PM2 sem `max_log_size`** | `ecosystem.config.js` | `~/.pm2/logs/*.log` cresce até o disco encher |
| G6 | **Coleta de métricas cria 1 linha/min** | `metrics-collector-scheduler.service.ts` | 1440 linhas/dia; purga só depois de 7 dias |
| G7 | **SQLite sem PRAGMA de WAL/busy_timeout** | `schema.prisma` (datasource sqlite) | escritas concorrentes podem dar `SQLITE_BUSY` |
| G8 | **Assumption de 1 vCPU no threshold de load** | `resource-guard.cjs` (`load1Max = 1.5`) | fixo, não normalizado por `cpuCount` |
| G9 | **Polling do frontend em várias telas** | `dashboard/page.tsx` (30 s), `projects/page.tsx` (10 s), `deploy-history.tsx` (2 s), `backups-panel.tsx` (1.5 s) | cada tela aberta = 1 timer + N requests |
| G10 | **`docker exec` por comando de cron/log** | `docker-exec-cron-runner.ts`, `docker-exec-database-query-runner.ts` | subprocesso Docker por execução |

---

## 3. Consumo do Core (auditoria)

### 3.1 Runtime (o que roda o tempo todo)

| Processo | Heap máx. (V8) | Teto PM2 | Observação |
|---|---|---|---|
| `korrelo-api` (NestJS + Prisma + SQLite) | 192 MB | `max_memory_restart: 256M` | `NODE_OPTIONS` no `ecosystem.config.js` |
| `korrelo-web` (Next standalone) | 192 MB | `max_memory_restart: 256M` | `server.js` standalone (bem mais leve que `next start`) |

Somando o **teto teórico**: 512 MB (2 × 256 MB) + ~150-250 MB de runtime Node/Prisma fora do heap → **~700-800 MB pico** do Core sozinho.

Baseline observado (estimativa estrutural): API ≈ 120-180 MB RSS · Web ≈ 90-150 MB RSS · **Core ≈ 250-350 MB em repouso**.

### 3.2 Por fase

| Fase | Consumo | Duração (VPS 1 vCPU) |
|---|---|---|
| Idle | ~250-350 MB (Core) + containers | contínuo |
| Coleta de métricas | 2 subprocessos Docker (`ps` + `stats --no-stream`) | ~100-400 ms a cada 60 s |
| Runtime reconcile | `docker ps` + `docker inspect` por projeto | ~50-150 ms por projeto |
| Worker de deploy | polling da fila a cada **2 s** | ~0,5% CPU |
| `npm ci --include=dev` | ~300-500 MB | 1-3 min |
| build shared-types | ~200-400 MB (tsc) | 20-60 s |
| build API (Nest) | ~500-900 MB (tsc + webpack) | 1-3 min |
| build web (Next) | ~800-1200 MB | 2-5 min |
| backup SQLite | ~10-50 MB (`.backup`) | segundos |
| migrations Prisma | ~50-150 MB | segundos |
| rollout completo | **pico ~1,2 GB** (durante o build web) | 5-12 min |

**Conclusão:** o Core em repouso (~300 MB) é pequeno; o **pico** é o build.

---

## 4. Docker overhead (chamadas por minuto)

Estimativa com 2 projetos, dashboard aberto e coleta de métricas ativa:

| Chamada | Frequência | Origem |
|---|---|---|
| `docker ps` | 1/min (métricas) + 1/min (runtime reconcile, no boot) | `os-system-metrics-collector`, `runtime-reconciliation.service` |
| `docker stats --no-stream` | 1/min | `os-system-metrics-collector` |
| `docker ps` (portas) | 1 por deploy | `port-allocator` |
| `docker ps` (preflight de recurso) | 1 por deploy | `resource-preflight.service` |
| `docker inspect` | 1-2 por projeto por reconcile | `runtime-reconciliation.service` |
| `docker exec` | 1 por comando de cron/log do projeto | `docker-exec-*` |

**Total tipicamente: 4-8 processos Docker/min em repouso; 20+ durante um deploy.**

Custo: cada `docker stats --no-stream` no Docker daemon custa ~50-150 ms de CPU do daemon (ele lê /proc de todos os containers). Em 1 vCPU, 1 chamada/min é aceitável; 1 a cada 10 s (se o dashboard polasse rápido) seria alfa de 10-15% de CPU do host.

**Proposta (P1):** cache de `docker ps`/`docker stats` por 15-30 s + `stale-while-revalidate`; usar **um** `docker inspect` por container em vez de vários.

---

## 5. SQLite

- **Engine:** SQLite via Prisma (`datasource db { provider = "sqlite" }`) — o Core é single-writer, o que é adequado para 1 API.
- **PRAGMAs:** **nenhum configurado** — sem `journal_mode=WAL`, sem `busy_timeout`, sem `synchronous=NORMAL`.
- **Tabelas que crescem:**
  - `MetricSample`: 1 linha/min ≈ 1440/dia; **purga com 7 dias** ✓ (o scheduler roda de 1 h em 1 h ✓) → pico ≈ 10.080 linhas (≈ 1-2 MB) — **saudável**;
  - `DeployRecord.log`: texto livre por deploy, **sem teto e sem purga** ⚠️;
  - `RefreshToken`: revogados ficam no banco até o `onDelete: Cascade` do usuário ⚠️ (cresce com logins).
- **Risco:** `SQLITE_BUSY` quando o writer (API) disputa com o reader (a mesma API ✗ → é o mesmo processo ✓) — o risco real é o **backup** (`sqlite3 .backup` em outro processo) ⚠️ → o `.backup` do SQLite é seguro para escrita concorrente ✓, mas um `VACUUM`/escrita longa poderia Finds.

**Propostas:**
- **P1:** `PRAGMA journal_mode=WAL` + `busy_timeout=5000` na inicialização do Prisma (melhora leitura concorrente e reduz `SQLITE_BUSY`).
- **P1:** teto no `DeployRecord.log` (ex.: 64 KB) e/or purga de registros com N dias.
- **P2:** purga de `RefreshToken` revogados/expirados (higiene).

---

## 6. Logs

| Fonte | Onde | Rotação atual | Risco |
|---|---|---|---|
| PM2 (API/Web) | `~/.pm2/logs/` | **nenhuma** (`ecosystem.config.js` não define `max_log_size`) | ⚠️ **enche o disco** |
| PM2 `pm2.log` (gestão) | `~/.pm2/pm2.log` | nenhuma | ⚠️ |
| Log do self-update | `~/.korrelo/self-update/<job>.log` | **Wave 3**: leitura limitada a 200 KB na API, mas o **arquivo em disco não é rotacionado** ⚠️ | médio |
| `update.log` (legado) | `~/.korrelo/update.log` | reescrito a cada update ✓ | baixo |
| Log de deploy | `DeployRecord.log` (SQLite) | sem teto ⚠️ | médio |
| Logs Docker | `docker logs` dos containers | política do daemon (json-file, sem limite ✗) | ⚠️ |

**Propostas (P1):** `max_log_size: "10M"` + `retain: 3` no `ecosystem.config.js`; rotacionar o log do self-update (manter os 3 últimos); `log-opts` com `max-size` nos containers.

---

## 7. CPU

- O Korrelo é **I/O-bound**, não CPU-bound, em repouso.
- Picos de CPU: build do Core (1 vCPU saturada por minutos) e `docker stats`.
- **Threshold atual:** `load1 <= 1.5` — adequado para **1 vCPU**, mas **fixo**: em uma VPS de 4 vCPU, um load de 1.5 (37% de um core) bloqueia o build à toa.

**Proposta (P2 — não implementar agora):** normalizar por CPU: `load1Max = max(1.5, 1.5 * cpuCount)` com teto (`min(..., 4)`), ou `load1 / cpuCount <= 1.5`. O resource guard já injeta o provider de métricas ✓ — basta trocar a fórmula (risco baixo, mas muda a proteção de produção → requer decisão).

---

## 8. RAM

Modelo atual (fixo): `MemAvailable >= 1200 MB`, `swap usada <= 512 MB`, `load1 <= 1.5`, `disco >= 2 GB`, heap do build 1024 MB.

- Com 3915 MB totais e ~2305 MB disponíveis: sobra ~1,1 GB para Mesatta(1757)+Mongo(879)+Evolution(1757)+PG(586)+Redis(586) durante o build ⚠️ (os limites somam ~5,5 GB > RAM → o que vale é o **uso real**).
- O piso de 1200 MB foi calibrado para essa VPS ⚠️ → **não é portável**.

**Proposta (P1, sem implement):** derivar o piso de `MemAvailable` de um `coreReserve` (≈ 400 MB) + `buildReserve` (≈ 700 MB) + folga por contêiner, ou seja `memRequired = coreReserve + buildReserve + maiorContainerObservado`. Com isso, numa VPS de 8 GB o build teria folga e numa de 2 GB seria adiado (correto).

---

## 9. Swap

- É **desejável** (não obrigatória): o build do Next pode tocar 1 GB; sem swap, o OOM killer mataria o build (e poderia matar um container de produção ✗✗ — o pior cenário).
- **Recomendado:** ≥ 2 GB com `swappiness` baixa (10-20) — reduz o thrashing e mantém o swap como amortecedor, não como memória.
- **Quando bloquear o build:** MemAvailable < 1,2 GB **ou** swap usada > 512 MB (a política atual ✓ coerente).
- **Detectar thrashing:** hoje não existe ⚠️ → proposta: considerar `swap usada > 25% do total` como sinal de pressão (P2).

**Não alterar sysctl sem autorização.**

---

## 10. Disco

| Crescimento | Onde | Retenção atual |
|---|---|---|
| Imagens Docker (builds de projeto) | `/var/lib/docker` | prune por usuário no fluxo de deploy (`image prune`, `builder prune --reserved-space 2GB`) ✓ parcial |
| `node_modules` do Core | repo | substituído pelo `npm ci` ⚠️ (o antigo é removido pelo npm, mas durante a coexistência o pico dobra) |
| Cache npm | `~/.npm` | **sem prune** ⚠️ (tipicamente 0,5-2 GB) |
| Worktrees de staging | `~/.korrelo`/workspaces | limpeza no `finally` do job ✓, mas órfãos dependem do boot |
| Backups do Core | `~/korrelo-backups` | **sem retenção** ⚠️ (um por update) |
| Backups de artefatos (Wave 3) | `~/.korrelo/self-update/` | **sem retenção** ⚠️ |
| SQLite | `apps/api/prisma/dev.db` | cresce com logs de deploy ⚠️ |
| Uploads/logs de projeto | volume Docker | **sem política no Core** ⚠️ |

**Propostas (P1/P2):** reter os N últimos backups do Core; `npm cache verify`/prune no rollout; orçamento de disco para staging (o guard já exige 2 GB livres ✓).

---

## 11. Build local do Core

Alternativas avaliadas:

| Opção | RAM | CPU | Tempo | Confiabilidade | Rollback | Complexidade |
|---|---|---|---|---|---|---|
| **A) build local (atual)** | até 1,2 GB | 1 vCPU | 5-12 min | média (OOM/timeout) | trivial (git checkout) | **nenhuma** |
| **B) GitHub Actions gera artefato** | 0 na VPS | CI | igual | alta (build reprodutível) | médio (artefato por commit) | média |
| **C) tarball de release** | ~50 MB de download | ~0 | 1-2 min | alta | médio | média |
| **D) imagem Docker do Core** | ~300 MB de runtime | baixo | 1-3 min | alta | fácil (troca de imagem) | **alta** (muda a arquitetura do Core) |
| **E) builder remoto** | 0 | 0 | depende | média | médio | alta (precisa de host) |
| **F) build em máquina externa + `scp`** | 0 | 0 | ~1 min | média (artefato desatualizado) | médio | média |

**Recomendação (P1):** **B/C** — o CI gera o artefato do Core (tarball com `dist/` + `.next/standalone`) e o rollout na VPS só **baixa e extrai** (peak de RAM ~0, pico de disco ~200 MB). O build local fica como fallback explícito (`KORRELO_ROLLOUT_BUILD_MODE=local`), e o guard de recursos continua valendo para o fallback.

---

## 12. Builds de projetos (hospedados)

- O Korrelo builda projetos de cliente **dentro de containers de staging** (Docker), com `ResourcePreflightService` + orçamento de memória por projeto (grandfathering preserva a produção) ✓.
- Docker BuildKit: há `docker buildx version` sendo consultado no prune ⚠️ → o buildkit está no caminho, mas **sem `--cpus`/`--memory` explícitos** no build ⚠️ → um build de cliente pode saturar a CPU do host.
- **Risco:** um build de cliente derruba outros clientes ⚠️ → proposta (P1): limitar CPU/memória do build (`docker build --cpus=0.8 --memory=1g`), `nice`/`ionice` no build e concorrência 1 (já é sequencial ✓).

---

## 13. Minimum requirements (estimativa)

| Cenário | Mínimo absoluto | Recomendado | Produção |
|---|---|---|---|
| Korrelo sozinho (API+Web) | 1 GB RAM, 1 vCPU, 15 GB disco | 2 GB, 1-2 vCPU, 30 GB | 2 GB, 2 vCPU, 40 GB |
| Korrelo + 1 app (sem banco) | 1,5 GB | 2,5 GB | 3 GB |
| Korrelo + 1 app + 1 banco | 2 GB (+ swap 1 GB) | 3 GB | 4 GB |
| Korrelo + vários projetos + build local do Core | 3 GB (+ swap 2 GB) | 4 GB | 6 GB (ou build externo) |
| Korrelo + vários projetos **sem** build local (artefato pronto) | 2 GB | 3 GB | 4 GB |

Swap: **2 GB** recomendado (o build do Next pode tocar 1 GB).

---

## 14. Perfis de host (proposta `HostProfile`)

Cálculo contínuo (sem hardcode), a partir de `MemTotal`, `MemAvailable`, `swapTotal`, `cpuCount`, `diskAvailable` e do **uso observado** dos containers:

```
coreReserve   = 512 MB (API+Web+Prisma+SQLite)
buildReserve  = 1024 MB (heap do build) — 0 se o build for externo
containerObs  = soma do uso real (docker stats) dos containers de projeto
headroom      = max(256 MB, 10% do total)
memRequired   = coreReserve + buildReserve + containerObs + headroom
```

| Perfil | Gatilho | Efeitos |
|---|---|---|
| **TINY** | total ≤ 1 GB | deploy concurrency 1 · staging ≤ 256 MB · dashboard 120 s · **build bloqueado** (exige artefato externo) · métricas a cada 5 min |
| **SMALL** | total ≤ 2 GB | deploy concurrency 1 · staging ≤ 512 MB · dashboard 60 s · build só com folga real (heap 768 MB) · métricas a cada 2 min |
| **MEDIUM** | total ≤ 4 GB | deploy concurrency 1 · staging ≤ 1 GB · dashboard 30 s · build heap 1024 MB · métricas a cada 1 min |
| **LARGE** | total ≥ 8 GB | deploy concurrency 2 · staging ≤ 2 GB · dashboard 10-15 s · build heap 1536 MB · métricas a cada 30 s |

O perfil controla: concorrência do worker, orçamento de staging, frequência do dashboard/coleta, permissão de build, heap do build, retenção e cadência das métricas.

---

## 15. Matriz de portabilidade

| Recurso | Ubuntu/Debian | Categoria | Fallback |
|---|---|---|---|
| `node` ≥ 20 | Required | **REQUIRED** | — |
| `npm` | Required | **REQUIRED** | — |
| `bash` | Required (scripts) | **REQUIRED** (só para o rollout) | o CLI do rollout é JS; os `.sh` são wrappers |
| `git` | Required | **REQUIRED** | — |
| `sqlite3` (CLI) | Required (backup do Core) | **REQUIRED** | ⚠️ sem fallback: sem `sqlite3` o backup falha e o rollout aborta |
| Docker CLI + daemon | Required (projetos) | **REQUIRED** | — |
| `pm2` | Required (restart) | **REQUIRED** | — |
| `/proc/meminfo` | Linux | OPTIONAL | métrica indisponível → o guard **não bloqueia** (já implementado ✓) |
| `os.loadavg()` | POSIX | OPTIONAL | idem ✓ |
| `free`, `df` | GNU coreutils | OPTIONAL | idem ✓ |
| `nice` | GNU coreutils | OPTIONAL | sem nice → build sem prioridade reduzida (já implementado ✓) |
| `ionice` | util-linux | OPTIONAL | idem ✓ |
| `setsid` | util-linux | OPTIONAL | **não usado** (o double fork do launcher é em Node ✓) |
| `systemd` | — | OPTIONAL | o PM2 é o supervisor; não há dependência de systemd ✓ |
| `/etc/npmrc`, `~/.npmrc` | — | OPTIONAL | **não são tocados** ✓ (o `--include=dev` é local ao comando) |
| `sudo`/`root` | — | OPTIONAL | o rollout roda como o usuário do PM2 ✓ |

**Conclusão de portabilidade:** o Core roda em qualquer VPS Linux x86-64 com Node 20+, Docker, PM2, git, npm e `sqlite3` CLI. As métricas de recurso degradam com elegância (indisponível → não bloqueia). **A dependência dura é `sqlite3` CLI** (backup do Core) e **bash** (wrappers) — ambas documentáveis no setup.

---

## 16. Achados priorizados (P0/P1/P2/P3)

| # | Achado | Sev | Impacto | Custo CPU | Custo RAM | Custo disco | Risco prod. | Solução | Complexidade | Prio |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | Logs do PM2 sem `max_log_size` | Alta | Disco enche e derruba a VPS | — | — | **Alto** | Alto | `max_log_size: 10M`, `retain: 3` | Baixa | **P0** |
| A2 | `DeployRecord.log` sem teto nem purga | Média | SQLite cresce sem limite | Baixo | — | Médio | Médio | Teto 64 KB + purga por idade | Baixa | **P0** |
| A3 | Build do Core na VPS (pico ~1,2 GB) | Alta | Pressão → risco aos projetos | **Alto** | **Alto** | Médio | **Alto** | Artefato do CI (B/C) + build local como fallback | Média | **P0** |
| A4 | `docker stats` a cada 60 s (sem cache) | Média | CPU do daemon constante | Médio | — | — | Baixo | Cache 15-30 s + stale-while-revalidate | Baixa | **P1** |
| A5 | `docker ps` por chamada (portas/preflight) | Média | N subprocessos por deploy | Médio | — | — | Baixo | Cache compartilhado de `docker ps` | Baixa | **P1** |
| A6 | Thresholds de RAM/load fixos (não portáveis) | Média | Em VPS grande o build é bloqueado à toa; em VPS pequena o build pode passar | — | — | — | Médio | `HostProfile` contínuo (§14) | Média | **P1** |
| A7 | SQLite sem WAL/busy_timeout | Média | `SQLITE_BUSY` sob concorrência | Baixo | — | — | Médio | PRAGMAs na inicialização | Baixa | **P1** |
| A8 | Logs Docker sem `max-size` | Média | Disco enche | — | — | Alto | Alto | `log-opts` nos containers | Média | **P1** |
| A9 | Backups do Core/artefatos sem retenção | Média | Disco | — | — | Médio | Baixo | Reter N últimos | Baixa | **P1** |
| A10 | `npm cache` sem prune | Baixa | Disco | — | — | Médio | Baixo | `npm cache verify`/prune no rollout | Baixa | **P2** |
| A11 | Build de cliente sem `--cpus/--memory` | Média | Build de um cliente derruba outros | **Alto** | **Alto** | — | **Alto** | Limitar CPU/memória do build + nice/ionice | Média | **P1** |
| A12 | `RefreshToken` revogados nunca purgados | Baixa | Tabela cresce | Baixo | — | Baixo | Baixo | Purga de expirados/revogados | Baixa | **P2** |
| A13 | Polling do frontend em várias telas (1,5 s a 30 s) | Baixa | Requests + CPU com várias abas | Baixo | — | — | Baixo | Perfis de dashboard (LOW/BALANCED/FAST) | Baixa | **P2** |
| A14 | `docker exec` por comando de cron/log | Baixa | Subprocesso por execução | Baixo | — | — | Baixo | Reaproveitar sessão / batch | Média | **P2** |
| A15 | Detecção de thrashing de swap inexistente | Baixa | Build roda em ambiente degradado | — | — | — | Médio | Usar % de swap usada no guard | Baixa | **P2** |
| A16 | Load threshold não normalizado por CPU | Baixa | Comportamento diferente por hardware | — | — | — | Baixo | `load1 / cpuCount` | Baixa | **P3** |
| A17 | Amostras de métrica 7 dias (10k linhas) | Baixa | ~1-2 MB | — | — | Baixo | Baixo | Já está OK ✓ | — | **P3** |
| A18 | `sqlite3` CLI é REQUIRED sem fallback | Baixa | Rollout falha em imagem mínima | — | — | — | Médio | Fallback via `better-sqlite3`/backup do Prisma | Média | **P3** |

---

## 17. Plano de implementação futuro (waves propostas)

**Wave Performance 1 — quick wins de baixo risco**
A1 (rotação de log do PM2) · A2 (teto/purga do log de deploy) · A4/A5 (cache de `docker ps`/`stats`) · A7 (PRAGMAs do SQLite) · A9 (retenção de backups).

**Wave Performance 2 — `HostProfile` adaptativo**
A6 + perfis TINY/SMALL/MEDIUM/LARGE (§14) + normalização do load por CPU (A16) + cadência de métricas/dashboard por perfil (A13).

**Wave Performance 3 — estratégia de build**
A3: artefato do CI (tarball/imagem) com o build local como fallback explícito e o resource guard valendo nos dois caminhos.

**Wave Performance 4 — armazenamento e retenção**
A8 (log-opts dos containers) · A10 (npm cache) · A12 (refresh tokens) · backups por perfil.

**Wave Performance 5 — observabilidade avançada**
Métricas de: latência do Docker, duração de deploy, duração de build, espera na fila, duração do self-update, pressão do host (histórico), e alertas por threshold.

---

## 18. Riscos desta auditoria

- **Estimativas de RAM são estruturais** (derivadas de `ecosystem.config.js` e do comportamento do build), não medidas com profiler na VPS. Antes de implementar qualquer wave, medir RSS real em repouso e durante o build (`pm2 monit` / `docker stats`).
- **A carga real de Docker no host** (quantos containers, de quais clientes) não é conhecida por esta auditoria — ela varia por instalação.
- As propostas de `HostProfile` mudam **proteção de produção** (quando o build pode ou não rodar): cada mudança precisa de decisão explícita e de novos testes, como as waves anteriores.
- Nada aqui foi implementado: **nenhuma alteração de runtime, threshold, container ou VPS** foi feita nesta auditoria.
