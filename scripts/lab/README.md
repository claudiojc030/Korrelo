# Laboratório de medição de build/staging (Fase C.3b)

Ferramenta **manual** para medir o consumo real de memória de um projeto
(Mesatta) ao compilar e ao iniciar o staging. Não é usada pelo Korrelo em
runtime, não altera preflight, fila, margens nem containers de produção.

> **Nunca execute na VPS comercial.** Use um host de laboratório com Docker
> próprio, sem acesso aos bancos comerciais.

## Pré-requisitos

- Linux com Docker Engine + `docker buildx` e cgroup v2 (recomendado).
- `git`, `node` (>= 20), `bash`, `sha256sum`/`shasum`, `curl`.
- `timeout` (coreutils) e `realpath`.
- Acesso de leitura ao clone do projeto no commit exato.
- Permissão para ler o cgroup dos containers que o próprio laboratório cria.
  Reset de `memory.peak` exige root; sem ele o pico ainda é válido porque o
  builder é novo a cada execução.
- Espaço livre estimado: **~11 GB** e RAM livre >= maior limite + 1 GB.

## Autorização

- `--dry-run` é seguro e não cria/baixa/compila nada.
- A execução real exige **as duas coisas**:
  - `KORRELO_LAB_AUTHORIZED=1`
  - `--yes`

O script não usa o builder padrão do Docker, não faz `docker system prune` e
não remove nada fora dos nomes `korrelo-lab-<run-id>-*`.

## Parâmetros

| Parâmetro | Default | Observação |
|---|---|---|
| `--project-id` | — | obrigatório; compõe o fingerprint |
| `--repo` | — | clone local do projeto |
| `--commit` | — | precisa ser exatamente o `HEAD` do clone |
| `--dockerfile` | `Dockerfile` | caminho relativo no commit |
| `--lockfile` | auto | package-lock/yarn/pnpm/bun/composer/go.sum/Cargo |
| `--cache` | `cold` | `cold` ou `warm`; obrigatório no relatório |
| `--build-memory-mb` | `1024` | limite do container do builder |
| `--build-cpus` | `1` | limite do container do builder |
| `--staging-memory-mb` | `768` | limite do container de staging |
| `--staging-cpus` | `1` | limite de CPU do staging |
| `--mongo-memory-mb` | `512` | só com `--needs-mongo` |
| `--mongo-image` | `mongo:7` | prefira `mongo:7@sha256:...` para reprodutibilidade |
| `--needs-mongo` | off | Mongo efêmero, sem volume nomeado |
| `--env NOME=valor` | — | repetível; variável fictícia de laboratório |
| `--allow-running-as-healthy` | off | aceita `running` sem healthcheck (menos confiável) |
| `--staging-command` | entrypoint | comando explícito do staging |
| `--staging-port` | `18080` | publicado só em `127.0.0.1` |
| `--container-port` | `3000` | porta interna |
| `--health-path` | — | HTTP 2xx = saudável |
| `--health-timeout-sec` | `120` | espera máxima do health |
| `--steady-sec` | `60` | janela de regime após o health |
| `--target-arch` | `uname -m` | ambiente de destino (comparação) |
| `--target-cgroup` | host | cgroup do destino (`1`/`2`) |
| `--target-memory-mb` | — | RAM total da VPS de destino |
| `--workdir` | `${TMPDIR}/korrelo-lab/<run-id>` | contexto/logs |
| `--report-dir` | `~/.korrelo/lab/reports` | relatórios preservados |
| `--keep` | off | preserva recursos/builder para inspeção |
| `--dry-run` | off | só mostra plano + estimativa |

## Comando exato para execução futura autorizada

```bash
# 1) Sempre primeiro, sem Docker pesado:
scripts/lab/measure-project-profile.sh \
  --project-id proj-mesatta \
  --repo /srv/lab/mesatta \
  --commit "$(git -C /srv/lab/mesatta rev-parse HEAD)" \
  --cache cold \
  --dry-run

# 2) Execução real (somente após autorização explícita):
KORRELO_LAB_AUTHORIZED=1 bash scripts/lab/measure-project-profile.sh \
  --project-id proj-mesatta \
  --repo /srv/lab/mesatta \
  --commit "$(git -C /srv/lab/mesatta rev-parse HEAD)" \
  --dockerfile Dockerfile \
  --cache cold \
  --build-memory-mb 1024 \
  --build-cpus 1 \
  --staging-memory-mb 768 \
  --staging-cpus 1 \
  --needs-mongo \
  --mongo-image "mongo:7@sha256:<digest>" \
  --mongo-memory-mb 512 \
  --health-path /health/ready \
  --target-arch x86_64 \
  --target-cgroup 2 \
  --target-memory-mb 4096 \
  --yes
```

`--staging-command` é opcional; sem ele vale o `CMD` da imagem. O laboratório
recusa Docker context remoto e não herda o ambiente do Core no build
(allowlist mínima de `PATH`/`HOME`/Docker).

Repita com `--cache warm` para medir a diferença de cache (o perfil guarda o
estado usado).

## O que é medido

Build:

- cgroup do container do builder (`memory.current`, `memory.peak`,
  `memory.events`, `memory.pressure`);
- amostragem de 1 Hz durante todo o build;
- pico real do cgroup, com fallback para a maior amostra (registrado como
  `peakSource`);
- OOM por `oom_kill`, `OOMKilled` e exit 137;
- tempo, exit code, timeout;
- cache cold/warm, versões de Docker/BuildKit, arquitetura, imagem-base;
- digest da imagem construída (pós-build).

Staging:

- pico de inicialização (até o health passar);
- pico durante o health;
- pico em regime (janela `--steady-sec`, amostras após o health);
- OOM, PSI, limite aplicado, saúde e tempo de inicialização.

## Relatório

- Formato `ResourceProfile` (Fase C.3a) + bloco `lab`.
- `~/.korrelo/lab/reports/<run-id>.json` (modo `0600`).
- Cópia bruta em `<workdir>/raw.saved.json`.
- `confidence` só é `high` quando build e staging concluem, sem OOM, com
  picos reais, PSI, digest e ambiente de destino compatível.
- `lab.allowedForReservationReduction` é **sempre `false`**.

## Falhas e limpeza

- OOM → `buildOutcome=oom`/`stagingOutcome=oom`, confiança `low`.
- Rede/registro/dependência → `external-failure` (não é evidência de memória).
- Sem pico real → `collection-failure`/`incomplete`.
- Timeout → `timeout`.
- Health reprovado → `external-failure`.

A limpeza padrão remove apenas:

- containers `korrelo-lab-<run-id>-staging` e `...-mongo`;
- rede `korrelo-lab-<run-id>-net`;
- builder `korrelo-lab-<run-id>-builder`;
- imagem `korrelo-lab-<run-id>-<projeto>:measure`.

Use `--keep` para inspecionar antes de remover. Nunca há prune genérico.

## Compatibilidade com o Mesatta (inspeção local do commit `125a4ab`)

Fatos confirmados nos objetos git locais (o worktree está sem checkout):

- Dockerfile real: multi-stage, base `node:22.23.4-alpine` **fixada por digest**.
- Build: `npm ci` → `npm run build` (`next build`).
- Runtime: `npm ci --omit=dev`; `CMD ["sh","-c","exec npm run start"]`.
- Start: `cross-env NODE_ENV=production tsx server.ts`; porta `PORT=3000`.
- Saúde: `/health/live` (processo) e `/health/ready` (ping real no Mongo, 503).
- Obrigatório: `MONGODB_URI` (lido no import de `src/lib/mongodb.ts`).
- Recomendado para boot: `NEXTAUTH_SECRET`/`AUTH_SECRET` fictícios, `NEXTAUTH_URL`.
- Sem Redis obrigatório nas dependências.
- O script já injeta `MONGODB_URI` do Mongo efêmero, segredos fictícios,
  `NEXTAUTH_URL` e `PORT`.
- O health depende do Mongo: use `--needs-mongo --health-path /health/ready`.
- Integrações externas (Asaas, Mercado Pago, IMAP, SEFAZ) são lazy ou falham
  em log; não são necessárias para `/health/ready`.

Pendências antes de uma execução real:

- confirmar o commit exato de produção (o `HEAD` do clone pode não ser);
- fixar o digest da imagem `mongo` em vez da tag `mongo:7`;
- confirmar variáveis extras de boot, se houver (`--env NOME=valor` fictício);
- validar `--target-memory-mb`/`--target-cgroup` da VPS de destino.
