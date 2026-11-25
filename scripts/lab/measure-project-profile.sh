#!/usr/bin/env bash
#
# KORRELO — Laboratório de medição de build/staging (Fase C.3b).
#
# Execução EXCLUSIVAMENTE MANUAL e AUTORIZADA. Não é chamado por deploy,
# preflight, fila, cron ou teste automatizado.
#
# O que este script faz:
#   1. valida host, commit, Dockerfile e estimativa de disco;
#   2. cria um builder Buildx docker-container DESCARTÁVEL e aplica limites
#      de CPU/RAM/swap SÓ nele (nunca no builder padrão);
#   3. builda o commit exato em um contexto criado por `git archive`
#      (sem untracked/secrets), medindo o cgroup do builder;
#   4. sobe um staging descartável com a imagem medida, banco efêmero
#      opcional e rede própria;
#   5. grava um relatório compatível com ResourceProfile;
#   6. remove SOMENTE os recursos criados por esta execução.
#
# Proibido neste script: `docker system prune`, prune de builder/volume,
# `docker rm` sem nome exato, remoção de imagens por filtro/curinga.
#
# Uso: veja scripts/lab/README.md

set -euo pipefail

LAB_HOME="${KORRELO_LAB_HOME:-$HOME/.korrelo/lab}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSEMBLE="$SCRIPT_DIR/lib/assemble-profile.mjs"

PROJECT_ID=""
COMMIT=""
REPO=""
DOCKERFILE_REL="Dockerfile"
LOCKFILE_REL=""
CACHE_STATE="cold"
BUILD_MEMORY_MB="1024"
BUILD_CPUS="1"
STAGING_MEMORY_MB="768"
STAGING_CPUS="1"
MONGO_MEMORY_MB="512"
MONGO_IMAGE="mongo:7"
NEEDS_MONGO="0"
STAGING_PORT="18080"
CONTAINER_PORT="3000"
HEALTH_PATH=""
HEALTH_TIMEOUT_SEC="120"
STEADY_SEC="60"
TARGET_ARCH=""
TARGET_CGROUP=""
TARGET_MEMORY_MB=""
WORKDIR=""
REPORT_DIR=""
KEEP="0"
ASSUME_YES="0"
DRY_RUN="0"
STAGING_COMMAND=""
ALLOW_RUNNING_AS_HEALTHY="0"
LAB_ENV=()

RUN_ID=""
PREFIX=""
BUILD_IMAGE=""
BUILDER_NAME=""
BUILDER_CONTAINER=""
STAGING_NAME=""
MONGO_NAME=""
NETWORK_NAME=""
CREATED=0
CLEANUP_DONE="0"
SAMPLER_PID=""
BUILD_EXIT=""
BUILD_TIMED_OUT="0"
STAGING_EXIT=""
BUILD_PEAK_FILE=""
BUILD_EVENTS_FILE=""
BUILD_PSI_MAX="0|0"
STAGING_PEAK_FILE=""
STAGING_EVENTS_FILE=""
STAGING_BOOT_PEAK=""
STAGING_STEADY_PEAK=""
STAGING_HEALTH_OK="0"
STAGING_STARTED_MS=""
STAGING_DURATION_MS=""
BUILD_STARTED_MS=""
BUILD_DURATION_MS=""

log() { printf '[lab] %s\n' "$*" >&2; }
fail() { printf '[lab] ERRO: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Uso:
  KORRELO_LAB_AUTHORIZED=1 scripts/lab/measure-project-profile.sh \
    --project-id proj-mesatta --repo /caminho/clone --commit <sha> --yes

Parâmetros:
  --project-id <id>          obrigatório
  --repo <dir>               clone local com o commit (obrigatório)
  --commit <sha>             commit fixado (obrigatório)
  --dockerfile <rel>         default: Dockerfile
  --lockfile <rel>           default: detecta package-lock/yarn/pnpm/bun
  --cache cold|warm          default: cold
  --build-memory-mb <n>      default: 1024
  --build-cpus <n>           default: 1
  --staging-memory-mb <n>    default: 768
  --staging-cpus <n>         default: 1
  --mongo-memory-mb <n>      default: 512
  --mongo-image <ref>        default: mongo:7 (prefira digest fixo)
  --needs-mongo             sobe mongo efêmero (sem volume nomeado)
  --staging-command <cmd>    comando do container de staging
  --env NOME=valor           variável de laboratório (repetível; nunca produção)
  --allow-running-as-healthy aceita "running" sem healthcheck (menos confiável)
  --staging-port <n>         default: 18080 (somente 127.0.0.1)
  --container-port <n>       default: 3000
  --health-path <path>       ex.: /health (HTTP 2xx = saudável)
  --health-timeout-sec <n>   default: 120
  --steady-sec <n>           default: 60
  --target-arch <arch>       default: uname -m
  --target-cgroup <1|2>      default: cgroup do host
  --target-memory-mb <n>     RAM total da VPS de destino (opcional)
  --workdir <dir>            default: ${TMPDIR}/korrelo-lab/<run-id>
  --report-dir <dir>         default: ~/.korrelo/lab/reports
  --keep                     não remove os recursos ao final
  --dry-run                  mostra plano/estimativa e NÃO executa nada
  --yes                      confirma a execução dispendiosa

Autorização: a execução real exige KORRELO_LAB_AUTHORIZED=1 E --yes.
USAGE
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --dockerfile) DOCKERFILE_REL="${2:-}"; shift 2 ;;
    --lockfile) LOCKFILE_REL="${2:-}"; shift 2 ;;
    --cache) CACHE_STATE="${2:-}"; shift 2 ;;
    --build-memory-mb) BUILD_MEMORY_MB="${2:-}"; shift 2 ;;
    --build-cpus) BUILD_CPUS="${2:-}"; shift 2 ;;
    --staging-memory-mb) STAGING_MEMORY_MB="${2:-}"; shift 2 ;;
    --staging-cpus) STAGING_CPUS="${2:-}"; shift 2 ;;
    --mongo-memory-mb) MONGO_MEMORY_MB="${2:-}"; shift 2 ;;
    --mongo-image) MONGO_IMAGE="${2:-}"; shift 2 ;;
    --needs-mongo) NEEDS_MONGO="1"; shift ;;
    --staging-command) STAGING_COMMAND="${2:-}"; shift 2 ;;
    --env) LAB_ENV+=("${2:-}"); shift 2 ;;
    --allow-running-as-healthy) ALLOW_RUNNING_AS_HEALTHY="1"; shift ;;
    --staging-port) STAGING_PORT="${2:-}"; shift 2 ;;
    --container-port) CONTAINER_PORT="${2:-}"; shift 2 ;;
    --health-path) HEALTH_PATH="${2:-}"; shift 2 ;;
    --health-timeout-sec) HEALTH_TIMEOUT_SEC="${2:-}"; shift 2 ;;
    --steady-sec) STEADY_SEC="${2:-}"; shift 2 ;;
    --target-arch) TARGET_ARCH="${2:-}"; shift 2 ;;
    --target-cgroup) TARGET_CGROUP="${2:-}"; shift 2 ;;
    --target-memory-mb) TARGET_MEMORY_MB="${2:-}"; shift 2 ;;
    --workdir) WORKDIR="${2:-}"; shift 2 ;;
    --report-dir) REPORT_DIR="${2:-}"; shift 2 ;;
    --keep) KEEP="1"; shift ;;
    --yes) ASSUME_YES="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage ;;
    *) fail "parâmetro desconhecido: $1" ;;
  esac
done

[ -n "$PROJECT_ID" ] || usage
[ -n "$REPO" ] || usage
[ -n "$COMMIT" ] || usage

for tool in docker node git; do
  command -v "$tool" >/dev/null 2>&1 || fail "ferramenta obrigatória ausente: $tool"
done

# O laboratório só pode falar com o Docker LOCAL. Contexto remoto poderia
# apontar para a VPS comercial.
DOCKER_CTX_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
case "${DOCKER_HOST:-}:$DOCKER_CTX_HOST" in
  *ssh://*|*tcp://*|*http://*|*https://*)
    fail "Docker context remoto não é permitido no laboratório (${DOCKER_HOST:-$DOCKER_CTX_HOST})" ;;
esac
if [ "$DRY_RUN" != "1" ]; then
  docker info >/dev/null 2>&1 || fail "Docker daemon local não responde"
  docker buildx version >/dev/null 2>&1 || fail "docker buildx não disponível"
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum/shasum ausente"
  fi
}

is_positive_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

for value in "$BUILD_MEMORY_MB" "$BUILD_CPUS" "$STAGING_MEMORY_MB" "$STAGING_CPUS" \
             "$MONGO_MEMORY_MB" "$STAGING_PORT" "$CONTAINER_PORT" \
             "$HEALTH_TIMEOUT_SEC" "$STEADY_SEC"; do
  is_positive_int "$value" || fail "valor inválido (esperado inteiro > 0): $value"
done

[ "$CACHE_STATE" = "cold" ] || [ "$CACHE_STATE" = "warm" ] || fail "--cache deve ser cold ou warm"
[ -e "$REPO/.git" ] || fail "--repo precisa ser um clone ou worktree git existente: $REPO"

for entry in ${LAB_ENV[@]+"${LAB_ENV[@]}"}; do
  name="${entry%%=*}"
  value="${entry#*=}"
  case "$name" in
    MONGODB_URI|MONGO_URL)
      fail "--env não pode definir banco; use --needs-mongo (banco efêmero do laboratório)" ;;
    DOCKER_HOST|DOCKER_CONTEXT)
      fail "--env não pode alterar o alvo do Docker" ;;
  esac
  case "$name" in
    [A-Z_][A-Z0-9_]*) ;;
    *) fail "--env com nome inválido: $name" ;;
  esac
  [ "$value" != "$entry" ] || fail "--env precisa ser NOME=valor: $entry"
done

ACTUAL_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
[ -n "$ACTUAL_COMMIT" ] || fail "não foi possível ler o commit de $REPO"
[ "$ACTUAL_COMMIT" = "$COMMIT" ] || fail "commit do clone ($ACTUAL_COMMIT) difere do solicitado ($COMMIT)"

if [ "$DRY_RUN" != "1" ]; then
  [ "${KORRELO_LAB_AUTHORIZED:-0}" = "1" ] || \
    fail "execução real exige KORRELO_LAB_AUTHORIZED=1 (proteção contra execução acidental)"
  [ "$ASSUME_YES" = "1" ] || \
    fail "execução real exige --yes (build do projeto é dispendioso; use --dry-run para ver o plano)"
  [ -f "$ASSEMBLE" ] || fail "montador de relatório ausente: $ASSEMBLE"
fi

mkdir -p "$LAB_HOME/locks" "$LAB_HOME/reports"
REPORT_DIR="${REPORT_DIR:-$LAB_HOME/reports}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
SLUG="$(printf '%s' "$PROJECT_ID" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-24)"
[ -n "$SLUG" ] || SLUG="project"
RUN_ID="run-${SLUG}-${STAMP}-$$"
PREFIX="korrelo-lab-${RUN_ID}"
BUILDER_NAME="${PREFIX}-builder"
BUILDER_CONTAINER="buildx_buildkit_${BUILDER_NAME}0"
BUILD_IMAGE="${PREFIX}:measure"
STAGING_NAME="${PREFIX}-staging"
MONGO_NAME="${PREFIX}-mongo"
NETWORK_NAME="${PREFIX}-net"
WORKDIR="${WORKDIR:-${TMPDIR:-/tmp}/korrelo-lab/$RUN_ID}"
CONTEXT_DIR="$WORKDIR/context"
LOGS_DIR="$WORKDIR/logs"
BUILD_PEAK_FILE="$LOGS_DIR/build.peak"
BUILD_EVENTS_FILE="$LOGS_DIR/build.events"
BUILD_PSI_FILE="$LOGS_DIR/build.psi"
STAGING_PEAK_FILE="$LOGS_DIR/staging.peak"
STAGING_EVENTS_FILE="$LOGS_DIR/staging.events"
STAGING_PSI_FILE="$LOGS_DIR/staging.psi"
REPORT_PATH="$REPORT_DIR/$RUN_ID.json"

DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
BUILDKIT_VERSION="$(docker buildx version 2>/dev/null | awk '{print $2}' || true)"
ARCH="$(uname -m)"
CGROUP_VERSION="1"
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  CGROUP_VERSION="2"
fi
TARGET_ARCH="${TARGET_ARCH:-$ARCH}"
TARGET_CGROUP="${TARGET_CGROUP:-$CGROUP_VERSION}"

MEM_AVAILABLE_MB="$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
DISK_FREE_MB="$(df -Pk "${DOCKER_DATA_ROOT:-/var/lib/docker}" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}' || true)"
[ -n "$MEM_AVAILABLE_MB" ] || MEM_AVAILABLE_MB="$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
[ -n "$DISK_FREE_MB" ] || DISK_FREE_MB="$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}' || echo 0)"
CPU_COUNT="$(nproc 2>/dev/null || echo 1)"
TOTAL_MEM_MB="$(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
is_positive_int "${TOTAL_MEM_MB:-}" || TOTAL_MEM_MB="null"

MEM_KNOWN="1"
DISK_KNOWN="1"
CPU_KNOWN="1"
is_positive_int "$MEM_AVAILABLE_MB" || { MEM_KNOWN="0"; MEM_AVAILABLE_MB="0"; }
is_positive_int "$DISK_FREE_MB" || { DISK_KNOWN="0"; DISK_FREE_MB="0"; }
is_positive_int "$CPU_COUNT" || { CPU_KNOWN="0"; CPU_COUNT="0"; }
if [ "$MEM_KNOWN$DISK_KNOWN$CPU_KNOWN" != "111" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "AVISO: métricas de host indisponíveis nesta plataforma; dry-run segue sem validá-las"
  else
    fail "não foi possível medir RAM/disco/CPU do host (MemAvailable=$MEM_AVAILABLE_MB disco=$DISK_FREE_MB cpu=$CPU_COUNT)"
  fi
fi

DISK_BASE_MB=2048
DISK_CACHE_MB=4096
DISK_EXPORT_MB=1024
DISK_RESERVE_MB=4096
DISK_TOTAL_MB=$((DISK_BASE_MB + DISK_CACHE_MB + DISK_EXPORT_MB + DISK_RESERVE_MB))
MEM_RESERVE_MB=1024
MEM_NEEDED_MB=$(( (BUILD_MEMORY_MB > STAGING_MEMORY_MB ? BUILD_MEMORY_MB : STAGING_MEMORY_MB) + MEM_RESERVE_MB ))

log "run=$RUN_ID commit=${COMMIT:0:12} cache=$CACHE_STATE"
log "host: RAM livre=${MEM_AVAILABLE_MB}MB disco livre=${DISK_FREE_MB}MB cpu=${CPU_COUNT} cgroup=v${CGROUP_VERSION} arch=$ARCH"
log "estimativa de disco: base=${DISK_BASE_MB}MB cache=${DISK_CACHE_MB}MB export=${DISK_EXPORT_MB}MB reserva=${DISK_RESERVE_MB}MB total=${DISK_TOTAL_MB}MB"
log "limites: build ${BUILD_MEMORY_MB}MB/${BUILD_CPUS}cpu swap=${BUILD_MEMORY_MB}MB; staging ${STAGING_MEMORY_MB}MB/${STAGING_CPUS}cpu; mongo ${MONGO_MEMORY_MB}MB"

if [ "$MEM_KNOWN" = "1" ] && [ "$MEM_AVAILABLE_MB" -lt "$MEM_NEEDED_MB" ]; then
  fail "RAM insuficiente: ${MEM_AVAILABLE_MB}MB livres; necessário ${MEM_NEEDED_MB}MB"
fi
if [ "$DISK_KNOWN" = "1" ] && [ "$DISK_FREE_MB" -lt "$DISK_TOTAL_MB" ]; then
  fail "disco insuficiente: ${DISK_FREE_MB}MB livres; estimativa ${DISK_TOTAL_MB}MB"
fi
if [ "$CPU_KNOWN" = "1" ] && [ "$CPU_COUNT" -lt "$BUILD_CPUS" ]; then
  fail "CPU insuficiente: ${CPU_COUNT} núcleos; build pede ${BUILD_CPUS}"
fi

OTHER_LOCKS="$(find "$LAB_HOME/locks" -mindepth 1 -maxdepth 1 -type d ! -name "${RUN_ID}.lock" -printf '%f\n' 2>/dev/null || true)"
if [ -n "$OTHER_LOCKS" ]; then
  fail "execução concorrente detectada: $(printf '%s' "$OTHER_LOCKS" | tr '\n' ' ')
remova manualmente o lock apenas se tiver certeza de que a execução morreu"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN: nada será criado/baixado/compilado"
  log "builder=$BUILDER_NAME (driver docker-container, descartável)"
  log "imagem=$BUILD_IMAGE staging=$STAGING_NAME rede=$NETWORK_NAME mongo=$([ "$NEEDS_MONGO" = "1" ] && echo "$MONGO_NAME" || echo "não")"
  log "workdir=$WORKDIR"
  log "relatório=$REPORT_PATH"
  log "autorização real: KORRELO_LAB_AUTHORIZED=1 e --yes"
  exit 0
fi

mkdir -p "$WORKDIR" "$CONTEXT_DIR" "$LOGS_DIR"
LOCK_DIR="$LAB_HOME/locks/${RUN_ID}.lock"
mkdir "$LOCK_DIR" || fail "não foi possível criar lock exclusivo ($LOCK_DIR)"

# ---------------------------------------------------------------------------
# cgroup helpers (v1/v2, com validação de ID e confinamento em /sys/fs/cgroup)
# ---------------------------------------------------------------------------
cgroup_dir_for() {
  local container="$1" full_id pid raw line rel root real
  full_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null || true)"
  pid="$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null || true)"
  [ -n "$full_id" ] && [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null || return 1
  [ -r "/proc/$pid/cgroup" ] || return 1
  raw="$(cat "/proc/$pid/cgroup")"

  line="$(printf '%s\n' "$raw" | awk -F: '$1==0 && $2=="" {print; exit}')"
  if [ -n "$line" ]; then
    rel="${line#0::}"
    root="/sys/fs/cgroup"
  else
    line="$(printf '%s\n' "$raw" | awk -F: '$2 ~ /(^|,)memory(,|$)/ {print; exit}')"
    [ -n "$line" ] || return 1
    rel="$(printf '%s' "$line" | cut -d: -f3)"
    root="/sys/fs/cgroup/memory"
  fi
  [ -n "$rel" ] || return 1
  case "$rel" in *..*) return 1 ;; esac
  real="$(realpath -m "$root$rel" 2>/dev/null || true)"
  [ -n "$real" ] || return 1
  case "$real" in "$root"/*) ;; *) return 1 ;; esac
  case "$real" in *"$full_id"*) ;; *) return 1 ;; esac
  printf '%s' "$real"
}

read_peak_mb() {
  local dir="$1" file bytes
  for file in "$dir/memory.peak" "$dir/memory.max_usage_in_bytes"; do
    if [ -r "$file" ]; then
      bytes="$(cat "$file" 2>/dev/null || true)"
      case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
      [ "$bytes" -gt 0 ] || return 1
      printf '%d' $(( (bytes + 1048575) / 1048576 ))
      return 0
    fi
  done
  return 1
}

read_events() {
  local dir="$1" file
  for file in "$dir/memory.events" "$dir/memory.oom_control"; do
    [ -r "$file" ] || continue
    if [ "$(basename "$file")" = "memory.oom_control" ]; then
      awk '/^oom_kill / {print "oom_kill " $2}' "$file"
    else
      awk '/^(oom|oom_kill) / {print}' "$file"
    fi
    return 0
  done
  echo ""
}

read_psi() {
  local dir="$1" file
  for file in "$dir/memory.pressure" "/sys/fs/cgroup/memory.pressure"; do
    [ -r "$file" ] || continue
    awk '/^some / {s=$2} /^full / {f=$2} END {print (s==""?"":s) "|" (f==""?"":f)}' "$file"
    return 0
  done
  echo ""
}

reset_peak_if_possible() {
  local dir="$1" file
  for file in "$dir/memory.peak"; do
    if [ -w "$file" ]; then
      if printf '0' > "$file" 2>/dev/null; then
        echo "1"
        return 0
      fi
    fi
  done
  echo "0"
}

# Amostra 1 Hz de memory.current + PSI; também tenta capturar o pico do kernel.
start_sampler() {
  local dir="$1" csv="$2" psi_csv="$3"
  (
    while :; do
      now="$(date +%s)"
      cur=""
      [ -r "$dir/memory.current" ] && cur="$(cat "$dir/memory.current" 2>/dev/null || true)"
      [ -n "$cur" ] || { [ -r "$dir/memory.usage_in_bytes" ] && cur="$(cat "$dir/memory.usage_in_bytes" 2>/dev/null || true)"; }
      psi="$(read_psi "$dir" 2>/dev/null || echo '0|0')"
      printf '%s,%s\n' "$now" "${cur:-}" >> "$csv"
      printf '%s,%s\n' "$now" "$psi" >> "$psi_csv"
      sleep 1
    done
  ) &
  SAMPLER_PID=$!
}

stop_sampler() {
  if [ -n "${SAMPLER_PID:-}" ]; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=""
  fi
}

max_sampled_mb() {
  local csv="$1"
  [ -s "$csv" ] || { echo ""; return 0; }
  awk -F, '$2 ~ /^[0-9]+$/ && $2>m {m=$2} END {if (m>0) printf "%d", (m+1048575)/1048576}' "$csv"
}

max_psi() {
  local csv="$1"
  [ -s "$csv" ] || { echo ""; return 0; }
  awk -F'[|,]' '{ if ($2!="") { if (s==""||$2+0>s+0) s=$2+0 } if ($3!="") { if (f==""||$3+0>f+0) f=$3+0 } } END { if (s==""&&f=="") print ""; else printf "%.4f|%.4f", s+0, f+0 }' "$csv"
}

max_sampled_mb_since() {
  local csv="$1" since="$2"
  [ -s "$csv" ] || { echo ""; return 0; }
  awk -F, -v since="$since" '$1+0 >= since && $2 ~ /^[0-9]+$/ && $2>m {m=$2} END {if (m>0) printf "%d", (m+1048575)/1048576}' "$csv"
}

cleanup() {
  [ "$CLEANUP_DONE" = "1" ] && return 0
  CLEANUP_DONE="1"
  stop_sampler
  if [ "$KEEP" = "1" ]; then
    log "KEEP=1: recursos preservados"
    log "  builder=$BUILDER_NAME containers=$STAGING_NAME${NEEDS_MONGO:+,$MONGO_NAME} network=$NETWORK_NAME image=$BUILD_IMAGE"
    return 0
  fi
  case "$STAGING_NAME" in "$PREFIX"*) docker rm -f -v "$STAGING_NAME" >/dev/null 2>&1 || true ;; esac
  if [ "$NEEDS_MONGO" = "1" ]; then
    case "$MONGO_NAME" in "$PREFIX"*) docker rm -f -v "$MONGO_NAME" >/dev/null 2>&1 || true ;; esac
  fi
  case "$NETWORK_NAME" in "$PREFIX"*) docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true ;; esac
  if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    docker buildx rm "$BUILDER_NAME" >/dev/null 2>&1 || true
  fi
  docker rmi "$BUILD_IMAGE" >/dev/null 2>&1 || true
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  log "limpeza concluída (somente recursos $PREFIX)"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Contexto reproduzível: git archive do commit exato (sem untracked/secrets)
# ---------------------------------------------------------------------------
log "exportando commit para contexto isolado (git archive)"
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$CONTEXT_DIR"
[ -f "$CONTEXT_DIR/$DOCKERFILE_REL" ] || fail "Dockerfile não encontrado no commit: $DOCKERFILE_REL"
[ -f "$CONTEXT_DIR/.dockerignore" ] || fail "commit sem .dockerignore; contexto do build não é confiável"
grep -qx '\.env' "$CONTEXT_DIR/.dockerignore" || fail ".dockerignore não exclui .env"

# Mesmo com git archive, um segredo versionado por engano entraria no contexto.
SENSITIVE_FILES="$(find "$CONTEXT_DIR" -type f \
  \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) \
     -o -name '*.pem' -o -name '*.key' -o -name '*.pfx' -o -name '*.p12' \) \
  -print 2>/dev/null | head -5 || true)"
[ -z "$SENSITIVE_FILES" ] || \
  fail "contexto contém arquivo sensível versionado: $(printf '%s' "$SENSITIVE_FILES" | tr '\n' ' ')"

DOCKERFILE_SHA="$(sha256_of "$CONTEXT_DIR/$DOCKERFILE_REL")"

if [ -z "$LOCKFILE_REL" ]; then
  for candidate in package-lock.json yarn.lock pnpm-lock.yaml bun.lockb composer.lock go.sum Cargo.lock requirements.txt; do
    if [ -f "$CONTEXT_DIR/$candidate" ]; then LOCKFILE_REL="$candidate"; break; fi
  done
fi
LOCKFILE_SHA="null"
if [ -n "$LOCKFILE_REL" ] && [ -f "$CONTEXT_DIR/$LOCKFILE_REL" ]; then
  LOCKFILE_SHA="\"$(sha256_of "$CONTEXT_DIR/$LOCKFILE_REL")\""
fi

BASE_IMAGE_ID="$(awk '/^FROM / {print $2; exit}' "$CONTEXT_DIR/$DOCKERFILE_REL" | sed 's/^--platform=[^ ]* //')"
case "$BASE_IMAGE_ID" in
  *@sha256:*)
    # O Dockerfile do Mesatta fixa a base por digest; usar o digest declarado
    # evita depender de a imagem já existir localmente.
    BASE_DIGEST="${BASE_IMAGE_ID##*@}" ;;
  *)
    BASE_DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "$BASE_IMAGE_ID" 2>/dev/null | sed 's/.*@//' || true)" ;;
esac
case "$BASE_DIGEST" in
  sha256:*) ;;
  *) BASE_DIGEST="null" ;;
esac

# ---------------------------------------------------------------------------
# Builder descartável com limites aplicados APENAS nele
# ---------------------------------------------------------------------------
log "criando builder descartável $BUILDER_NAME (driver docker-container)"
log "AVISO: a primeira execução pode baixar a imagem do builder e a base do Dockerfile"
docker buildx create --name "$BUILDER_NAME" --driver docker-container >/dev/null
docker buildx inspect --bootstrap "$BUILDER_NAME" >/dev/null

log "aplicando limites ao container do builder (${BUILD_MEMORY_MB}MB, ${BUILD_CPUS} cpu, swap=${BUILD_MEMORY_MB}MB)"
for _ in 1 2 3 4 5; do
  if docker inspect "$BUILDER_CONTAINER" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker inspect "$BUILDER_CONTAINER" >/dev/null 2>&1 || fail "container do builder não apareceu: $BUILDER_CONTAINER"
docker update --memory "${BUILD_MEMORY_MB}m" --memory-swap "${BUILD_MEMORY_MB}m" --cpus "$BUILD_CPUS" "$BUILDER_CONTAINER" >/dev/null
EXPECTED_MEM_BYTES=$((BUILD_MEMORY_MB * 1024 * 1024))
ACTUAL_MEM_BYTES="$(docker inspect -f '{{.HostConfig.Memory}}' "$BUILDER_CONTAINER")"
[ "$ACTUAL_MEM_BYTES" = "$EXPECTED_MEM_BYTES" ] || \
  fail "limite de memória não foi aplicado ao builder (esperado $EXPECTED_MEM_BYTES, obtido $ACTUAL_MEM_BYTES)"

BUILDER_CGROUP="$(cgroup_dir_for "$BUILDER_CONTAINER" || true)"
[ -n "$BUILDER_CGROUP" ] || fail "não foi possível localizar o cgroup do builder"
BUILDER_ID_BEFORE="$(docker inspect -f '{{.Id}}' "$BUILDER_CONTAINER")"
PEAK_RESET="$(reset_peak_if_possible "$BUILDER_CGROUP")"
log "cgroup do builder localizado; memory.peak reset=$PEAK_RESET"

# Ambiente do build deliberadamente mínimo: nada de env do Core/VPS entra no
# cliente além do necessário para falar com o Docker local.
BUILD_ENV=(env -i "PATH=$PATH" "HOME=${HOME:-/tmp}")
for var in DOCKER_CONFIG DOCKER_HOST DOCKER_CONTEXT XDG_RUNTIME_DIR TMPDIR; do
  if [ -n "${!var:-}" ]; then BUILD_ENV+=("$var=${!var}"); fi
done

BUILD_STARTED_MS="$(date +%s%3N)"
start_sampler "$BUILDER_CGROUP" "$BUILD_PEAK_FILE.csv" "$BUILD_PSI_FILE"
set +e
"${BUILD_ENV[@]}" timeout --signal=TERM --kill-after=30s 2400 \
  docker buildx build --builder "$BUILDER_NAME" \
  --file "$CONTEXT_DIR/$DOCKERFILE_REL" \
  --tag "$BUILD_IMAGE" --load --progress=plain "$CONTEXT_DIR" \
  >"$LOGS_DIR/build.log" 2>&1
BUILD_EXIT=$?
set -e
if [ "$BUILD_EXIT" = "124" ]; then BUILD_TIMED_OUT="1"; fi
stop_sampler
BUILD_DURATION_MS=$(( $(date +%s%3N) - BUILD_STARTED_MS ))

# O buildx pode recriar o container do builder; se isso acontecer, o limite e o
# cgroup medidos deixam de valer.
BUILDER_ID_AFTER="$(docker inspect -f '{{.Id}}' "$BUILDER_CONTAINER" 2>/dev/null || true)"
[ "$BUILDER_ID_AFTER" = "$BUILDER_ID_BEFORE" ] || \
  fail "builder foi recriado durante o build; medição inválida"

# O buildx pode recriar o container do builder; se isso acontecer, o limite
# configurado some. Sem limite comprovado, a medição não vale.
POST_MEM_BYTES="$(docker inspect -f '{{.HostConfig.Memory}}' "$BUILDER_CONTAINER" 2>/dev/null || true)"
[ "$POST_MEM_BYTES" = "$EXPECTED_MEM_BYTES" ] || \
  fail "limite de memória do builder não permaneceu aplicado durante o build (medição inválida)"

BUILD_PEAK_MB="$(read_peak_mb "$BUILDER_CGROUP" || true)"
BUILD_PEAK_SOURCE="cgroup-peak"
if [ -z "$BUILD_PEAK_MB" ]; then
  BUILD_PEAK_MB="$(max_sampled_mb "$BUILD_PEAK_FILE.csv")"
  BUILD_PEAK_SOURCE="sampled"
fi
[ -n "$BUILD_PEAK_MB" ] || BUILD_PEAK_SOURCE="null"
BUILD_EVENTS="$(read_events "$BUILDER_CGROUP" || true)"
BUILD_OOM_KILLED="false"
if docker inspect -f '{{.State.OOMKilled}}' "$BUILDER_CONTAINER" 2>/dev/null | grep -qi true; then
  BUILD_OOM_KILLED="true"
fi
BUILD_OOM_EVENTS="$(printf '%s\n' "$BUILD_EVENTS" | awk '/^oom_kill / {print $2}' | tail -1)"
[ -n "$BUILD_OOM_EVENTS" ] || BUILD_OOM_EVENTS="0"
BUILD_PSI_MAX="$(max_psi "$BUILD_PSI_FILE")"
[ -n "$BUILD_PSI_MAX" ] || BUILD_PSI_MAX="null|null"
BUILD_SAMPLES="$(wc -l < "$BUILD_PEAK_FILE.csv" 2>/dev/null | tr -d ' ' || echo 0)"
BUILD_MIN_SAMPLES=$(( BUILD_DURATION_MS / 1000 / 2 ))
[ "$BUILD_MIN_SAMPLES" -ge 1 ] || BUILD_MIN_SAMPLES=1
BUILD_SAMPLING_OK="false"
[ "${BUILD_SAMPLES:-0}" -ge "$BUILD_MIN_SAMPLES" ] && BUILD_SAMPLING_OK="true"

log "build exit=$BUILD_EXIT timeout=$BUILD_TIMED_OUT peak=${BUILD_PEAK_MB:-?}MB (${BUILD_PEAK_SOURCE}) oom=$BUILD_OOM_KILLED events=$BUILD_OOM_EVENTS"

# ---------------------------------------------------------------------------
# Staging descartável
# ---------------------------------------------------------------------------
STAGING_HEALTH_OK="0"
STAGING_HEALTH_SOURCE="none"
STAGING_PEAK_MB=""
STAGING_PEAK_SOURCE="null"
STAGING_OOM_KILLED="false"
STAGING_OOM_EVENTS="0"
STAGING_PSI_MAX="0|0"
STAGING_SAMPLES="0"
STAGING_BOOT_PEAK=""
STAGING_STEADY_PEAK=""
STAGING_DURATION_MS="null"

if [ "$BUILD_EXIT" = "0" ] && [ -n "$BUILD_PEAK_MB" ]; then
  docker network create --label "korrelo.lab.run=$RUN_ID" "$NETWORK_NAME" >/dev/null
  MONGO_ARGS=()
  if [ "$NEEDS_MONGO" = "1" ]; then
    log "subindo mongo efêmero (sem volume nomeado, rede isolada)"
    docker run -d --rm --name "$MONGO_NAME" --network "$NETWORK_NAME" \
      --label "korrelo.lab.run=$RUN_ID" \
      --memory "${MONGO_MEMORY_MB}m" --memory-swap "${MONGO_MEMORY_MB}m" \
      "$MONGO_IMAGE" >/dev/null
    for _ in $(seq 1 60); do
      if docker exec "$MONGO_NAME" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then
        MONGO_ARGS=(-e "MONGODB_URI=mongodb://$MONGO_NAME:27017/lab")
        break
      fi
      sleep 1
    done
    [ "${#MONGO_ARGS[@]}" -gt 0 ] || fail "mongo efêmero não ficou pronto"
  fi

  # Env mínimo e explicitamente fictício. Nenhum valor vem do ambiente do Core.
  STAGING_ENV_ARGS=(
    -e "PORT=$CONTAINER_PORT"
    -e "NEXTAUTH_URL=http://127.0.0.1:$STAGING_PORT"
    -e "NEXTAUTH_SECRET=korrelo-lab-not-a-real-secret"
    -e "AUTH_SECRET=korrelo-lab-not-a-real-secret"
  )
  for entry in ${LAB_ENV[@]+"${LAB_ENV[@]}"}; do STAGING_ENV_ARGS+=(-e "$entry"); done

  STAGING_ARGS=()
  [ -n "$STAGING_COMMAND" ] && STAGING_ARGS=(sh -lc "$STAGING_COMMAND")
  log "subindo staging descartável ${STAGING_MEMORY_MB}MB"
  docker run -d --name "$STAGING_NAME" --network "$NETWORK_NAME" \
    --memory "${STAGING_MEMORY_MB}m" --memory-swap "${STAGING_MEMORY_MB}m" \
    --cpus "$STAGING_CPUS" \
    -p "127.0.0.1:${STAGING_PORT}:${CONTAINER_PORT}" \
    --label "korrelo.lab.run=$RUN_ID" \
    ${MONGO_ARGS[@]+"${MONGO_ARGS[@]}"} \
    ${STAGING_ENV_ARGS[@]+"${STAGING_ENV_ARGS[@]}"} \
    "$BUILD_IMAGE" ${STAGING_ARGS[@]+"${STAGING_ARGS[@]}"} >/dev/null

  ACTUAL_STAGING_MEM="$(docker inspect -f '{{.HostConfig.Memory}}' "$STAGING_NAME")"
  [ "$ACTUAL_STAGING_MEM" = "$((STAGING_MEMORY_MB * 1024 * 1024))" ] || \
    fail "limite de memória do staging não foi aplicado"

  STAGING_CGROUP="$(cgroup_dir_for "$STAGING_NAME" || true)"
  STAGING_STARTED_MS="$(date +%s%3N)"
  if [ -n "$STAGING_CGROUP" ]; then
    reset_peak_if_possible "$STAGING_CGROUP" >/dev/null
    start_sampler "$STAGING_CGROUP" "$STAGING_PEAK_FILE.csv" "$STAGING_PSI_FILE"
  fi

  HEALTH_STARTED="$(date +%s)"
  while :; do
    if [ -n "$HEALTH_PATH" ]; then
      if curl -fsS --max-time 2 "http://127.0.0.1:${STAGING_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
        STAGING_HEALTH_OK="1"; STAGING_HEALTH_SOURCE="http"; break
      fi
    else
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$STAGING_NAME" 2>/dev/null || echo unknown)"
      case "$status" in
        healthy) STAGING_HEALTH_OK="1"; STAGING_HEALTH_SOURCE="docker-health"; break ;;
        running)
          if [ "$ALLOW_RUNNING_AS_HEALTHY" = "1" ]; then
            STAGING_HEALTH_OK="1"; STAGING_HEALTH_SOURCE="docker-running"; break
          fi
          ;;
      esac
    fi
    if ! docker inspect -f '{{.State.Running}}' "$STAGING_NAME" 2>/dev/null | grep -qi true; then
      break
    fi
    if [ $(( $(date +%s) - HEALTH_STARTED )) -ge "$HEALTH_TIMEOUT_SEC" ]; then
      break
    fi
    sleep 2
  done
  STAGING_DURATION_MS=$(( $(date +%s%3N) - STAGING_STARTED_MS ))
  STAGING_HEALTH_EPOCH="$(date +%s)"
  STAGING_BOOT_PEAK="$( [ -n "${STAGING_CGROUP:-}" ] && read_peak_mb "$STAGING_CGROUP" || max_sampled_mb "$STAGING_PEAK_FILE.csv" )"

  log "staging health=$STAGING_HEALTH_OK; regime de ${STEADY_SEC}s"
  if [ "$STAGING_HEALTH_OK" = "1" ]; then
    sleep "$STEADY_SEC"
    STAGING_STEADY_PEAK="$(max_sampled_mb_since "$STAGING_PEAK_FILE.csv" "$STAGING_HEALTH_EPOCH")"
  fi

  stop_sampler
  if [ -n "${STAGING_CGROUP:-}" ]; then
    if STAGING_PEAK_MB="$(read_peak_mb "$STAGING_CGROUP")"; then
      STAGING_PEAK_SOURCE="cgroup-peak"
    else
      STAGING_PEAK_MB="$(max_sampled_mb "$STAGING_PEAK_FILE.csv")"
      STAGING_PEAK_SOURCE="sampled"
    fi
    [ -n "$STAGING_PEAK_MB" ] || STAGING_PEAK_SOURCE="null"
    STAGING_EVENTS="$(read_events "$STAGING_CGROUP" || true)"
    STAGING_OOM_EVENTS="$(printf '%s\n' "$STAGING_EVENTS" | awk '/^oom_kill / {print $2}' | tail -1)"
    [ -n "$STAGING_OOM_EVENTS" ] || STAGING_OOM_EVENTS="0"
    STAGING_PSI_MAX="$(max_psi "$STAGING_PSI_FILE")"
    [ -n "$STAGING_PSI_MAX" ] || STAGING_PSI_MAX="null|null"
    STAGING_SAMPLES="$(wc -l < "$STAGING_PEAK_FILE.csv" 2>/dev/null | tr -d ' ' || echo 0)"
  fi
  STAGING_MIN_SAMPLES=$(( ${STAGING_DURATION_MS:-0} / 1000 / 2 ))
  [ "$STAGING_MIN_SAMPLES" -ge 1 ] || STAGING_MIN_SAMPLES=1
  STAGING_SAMPLING_OK="false"
  [ "${STAGING_SAMPLES:-0}" -ge "$STAGING_MIN_SAMPLES" ] && STAGING_SAMPLING_OK="true"
  # O pico final é o maior entre cgroup e as janelas medidas explicitamente.
  for candidate in "$STAGING_BOOT_PEAK" "$STAGING_STEADY_PEAK"; do
    if is_positive_int "$candidate"; then
      if ! is_positive_int "$STAGING_PEAK_MB" || [ "$candidate" -gt "$STAGING_PEAK_MB" ]; then
        STAGING_PEAK_MB="$candidate"
      fi
    fi
  done
  if docker inspect -f '{{.State.OOMKilled}}' "$STAGING_NAME" 2>/dev/null | grep -qi true; then
    STAGING_OOM_KILLED="true"
  fi
  log "staging peak=${STAGING_PEAK_MB:-?}MB boot=${STAGING_BOOT_PEAK:-?} steady=${STAGING_STEADY_PEAK:-?} oom=$STAGING_OOM_KILLED"
fi

# ---------------------------------------------------------------------------
# Relatório
# ---------------------------------------------------------------------------
MEASURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_DIGEST="$(docker image inspect -f '{{.Id}}' "$BUILD_IMAGE" 2>/dev/null || true)"
[ -n "$IMAGE_DIGEST" ] || IMAGE_DIGEST="null"

TARGET_MEMORY_JSON="null"
if [ -n "$TARGET_MEMORY_MB" ]; then TARGET_MEMORY_JSON="$TARGET_MEMORY_MB"; fi
BUILD_PEAK_JSON="null"
if [ -n "$BUILD_PEAK_MB" ]; then BUILD_PEAK_JSON="$BUILD_PEAK_MB"; fi
STAGING_PEAK_JSON="null"
if [ -n "$STAGING_PEAK_MB" ]; then STAGING_PEAK_JSON="$STAGING_PEAK_MB"; fi
BOOT_PEAK_JSON="null"
if [ -n "$STAGING_BOOT_PEAK" ]; then BOOT_PEAK_JSON="$STAGING_BOOT_PEAK"; fi
STEADY_PEAK_JSON="null"
if [ -n "$STAGING_STEADY_PEAK" ]; then STEADY_PEAK_JSON="$STAGING_STEADY_PEAK"; fi
BUILD_PSI_SOME="${BUILD_PSI_MAX%%|*}"
BUILD_PSI_FULL="${BUILD_PSI_MAX##*|}"
STAGING_PSI_SOME="${STAGING_PSI_MAX%%|*}"
STAGING_PSI_FULL="${STAGING_PSI_MAX##*|}"
STAGING_DURATION_JSON="$STAGING_DURATION_MS"

mkdir -p "$REPORT_DIR"
RAW_JSON="$WORKDIR/raw.json"
cat > "$RAW_JSON" <<JSON
{
  "run": { "id": "$RUN_ID", "exclusive": true, "concurrentMeasurements": 0 },
  "measuredAt": "$MEASURED_AT",
  "imageDigest": $([ "$IMAGE_DIGEST" = "null" ] && echo null || echo "\"$IMAGE_DIGEST\""),
  "inputs": {
    "projectId": "$PROJECT_ID",
    "commitSha": "$COMMIT",
    "dockerfileSha256": "$DOCKERFILE_SHA",
    "lockfileSha256": $LOCKFILE_SHA,
    "baseImageId": $([ "$BASE_DIGEST" = "null" ] && echo null || echo "\"$BASE_DIGEST\""),
    "cacheState": "$CACHE_STATE",
    "dockerVersion": "$DOCKER_VERSION",
    "buildkitVersion": "$BUILDKIT_VERSION",
    "arch": "$ARCH",
    "host": {
      "memAvailableMb": ${MEM_AVAILABLE_MB:-null},
      "diskFreeMb": ${DISK_FREE_MB:-null},
      "cpuCount": ${CPU_COUNT:-null},
      "cgroupVersion": $CGROUP_VERSION,
      "arch": "$ARCH",
      "dockerVersion": "$DOCKER_VERSION",
      "totalMemMb": $TOTAL_MEM_MB
    },
    "target": {
      "arch": "$TARGET_ARCH",
      "cgroupVersion": $TARGET_CGROUP,
      "dockerVersion": "$DOCKER_VERSION",
      "totalMemMb": $TARGET_MEMORY_JSON
    },
    "limits": {
      "buildMemoryMb": $BUILD_MEMORY_MB,
      "buildSwapMb": $BUILD_MEMORY_MB,
      "buildCpus": $BUILD_CPUS,
      "stagingMemoryMb": $STAGING_MEMORY_MB,
      "stagingSwapMb": $STAGING_MEMORY_MB,
      "stagingCpus": $STAGING_CPUS,
      "mongoMemoryMb": $MONGO_MEMORY_MB
    }
  },
  "build": {
    "exitCode": ${BUILD_EXIT:-null},
    "timedOut": $([ "$BUILD_TIMED_OUT" = "1" ] && echo true || echo false),
    "oomKilled": $BUILD_OOM_KILLED,
    "oomEvents": ${BUILD_OOM_EVENTS:-0},
    "peakMb": $BUILD_PEAK_JSON,
    "peakSource": $([ "$BUILD_PEAK_SOURCE" = "null" ] && echo null || echo "\"$BUILD_PEAK_SOURCE\""),
    "samples": ${BUILD_SAMPLES:-0},
    "samplingComplete": $BUILD_SAMPLING_OK,
    "durationMs": ${BUILD_DURATION_MS:-null},
    "pressureSomePeak": $BUILD_PSI_SOME,
    "pressureFullPeak": $BUILD_PSI_FULL
  },
  "staging": {
    "exitCode": 0,
    "timedOut": false,
    "oomKilled": $STAGING_OOM_KILLED,
    "oomEvents": ${STAGING_OOM_EVENTS:-0},
    "peakMb": $STAGING_PEAK_JSON,
    "peakSource": $([ "$STAGING_PEAK_SOURCE" = "null" ] && echo null || echo "\"$STAGING_PEAK_SOURCE\""),
    "samples": ${STAGING_SAMPLES:-0},
    "samplingComplete": $([ "${STAGING_SAMPLING_OK:-false}" = "true" ] && echo true || echo false),
    "durationMs": $STAGING_DURATION_JSON,
    "pressureSomePeak": $STAGING_PSI_SOME,
    "pressureFullPeak": $STAGING_PSI_FULL,
    "healthOk": $([ "$STAGING_HEALTH_OK" = "1" ] && echo true || echo false),
    "bootPeakMb": $BOOT_PEAK_JSON,
    "steadyPeakMb": $STEADY_PEAK_JSON
  },
  "notes": [
    "execução manual autorizada",
    "contexto gerado por git archive do commit fixado",
    "builder docker-container descartável com limites próprios",
    "healthSource=$STAGING_HEALTH_SOURCE",
    "buildSampling=$BUILD_SAMPLING_OK",
    "stagingSampling=${STAGING_SAMPLING_OK:-false}",
    "mongoImage=$MONGO_IMAGE"
  ]
}
JSON

# Anexa apenas o final do log (evita relatório gigante e vazamento de env).
node - "$RAW_JSON" "$LOGS_DIR/build.log" <<'NODE'
const fs = require("node:fs");
const [rawPath, logPath] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
try {
  raw.build.logTail = fs.readFileSync(logPath, "utf8").slice(-4000);
} catch {
  raw.build.logTail = null;
}
fs.writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
NODE

node "$ASSEMBLE" --raw "$RAW_JSON" --out "$REPORT_PATH"
cp "$RAW_JSON" "$WORKDIR/raw.saved.json"
log "relatório preservado: $REPORT_PATH"
log "não autoriza reduzir reservas; Fase C continua desligada"

exit 0
