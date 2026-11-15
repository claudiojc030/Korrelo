/**
 * PLANEJADOR DE STAGING ISOLADO (P0 — somente decisão, nunca executa Docker).
 *
 * Regras de compatibilidade:
 *  - ausência de configuração ou `mode="legacy"` = fluxo atual, sem validação
 *    adicional e sem exigir nenhum dado novo;
 *  - `mode="isolated"` só produz plano se TODAS as validações passarem;
 *  - falha de isolamento NUNCA cai para o modo legado silenciosamente.
 *
 * O plano é intencionalmente livre de valores secretos. Ele descreve nomes,
 * limites e referências; a renderização de env/compose e a reserva real de
 * porta/recursos pertencem às próximas fases.
 *
 * LIMITES DESTA FASE (P0):
 *  - fingerprint de segredo detecta reutilização EXATA, não prova ausência
 *    de acesso à produção;
 *  - `allowEgress` é liga/desliga; allowlist de domínio exige proxy/firewall;
 *  - a porta é apenas escolhida entre candidatos; a reserva atômica é P1;
 *  - nenhum volume, rede, banco ou container é criado por este módulo.
 */

export type StagingMode = "legacy" | "isolated";

/** Tipos suportados no MODELO desta fase. Nenhum container é criado aqui. */
export const SUPPORTED_STAGING_DEPENDENCY_KINDS = [
  "postgres",
  "mongodb",
  "mysql",
  "redis",
  "sqlite",
  "external",
] as const;

export type SupportedStagingDependencyKind = (typeof SUPPORTED_STAGING_DEPENDENCY_KINDS)[number];
export type StagingDependencyKind = SupportedStagingDependencyKind | (string & {});

export type StagingValidationCode =
  | "STAGING_MODE_INVALID"
  | "STAGING_CONFIG_INCOMPLETE"
  | "STAGING_CONFIG_INVALID"
  | "STAGING_UNSUPPORTED_DEPENDENCY"
  | "STAGING_DUPLICATE_DEPENDENCY"
  | "STAGING_DEPENDENCY_PROJECT_MISMATCH"
  | "STAGING_PRODUCTION_VOLUME"
  | "STAGING_SHARED_NETWORK"
  | "STAGING_PRODUCTION_NETWORK"
  | "STAGING_DOCKER_SOCKET"
  | "STAGING_PRIVILEGED"
  | "STAGING_HOST_NETWORK"
  | "STAGING_UNSUPPORTED_NAMESPACE"
  | "STAGING_BIND_MOUNT"
  | "STAGING_UNSUPPORTED_MOUNT"
  | "STAGING_PRODUCTION_DATABASE"
  | "STAGING_PRODUCTION_CREDENTIAL"
  | "STAGING_RESERVED_ENV"
  | "STAGING_DUPLICATE_ENV"
  | "STAGING_RESOURCE_CPU"
  | "STAGING_RESOURCE_MEMORY"
  | "STAGING_RESOURCE_DISK"
  | "STAGING_CONCURRENCY_LIMIT"
  | "STAGING_TTL_INVALID"
  | "STAGING_PORT_CONFLICT"
  | "STAGING_PUBLIC_EXPOSURE"
  | "STAGING_PRODUCTION_CONTEXT_MISSING";

export interface StagingValidationIssue {
  code: StagingValidationCode;
  field: string;
  message: string;
}

export interface StagingValidationResult {
  ok: boolean;
  mode: StagingMode;
  /** true quando o projeto deve continuar exatamente no fluxo atual. */
  legacy: boolean;
  issues: StagingValidationIssue[];
  /** null em modo legado ou quando a validação falhou. */
  plan: StagingPlan | null;
}

export interface StagingResourceRequest {
  /** Memória reservada ao serviço. Obrigatória e explícita. */
  memoryMb: number;
  /** CPU reservada ao serviço. Obrigatória e explícita. */
  cpu: number;
  /** Disco estimado para o serviço/volume. Obrigatório e explícito. */
  diskMb: number;
}

export interface StagingMountConfig {
  type: "volume" | "bind";
  source: string;
  target: string;
  readOnly?: boolean;
  /** Só tem efeito para `bind`; sem isto o bind é recusado. */
  authorized?: boolean;
}

export interface StagingAppConfig {
  memoryMb: number;
  cpu: number;
  diskMb: number;
  mounts?: StagingMountConfig[];
}

export interface StagingEnvBinding {
  key: string;
  source: "explicit" | "dependency";
  /**
   * SHA-256 do valor, quando conhecido. Usado SOMENTE para detectar
   * reutilização exata de um segredo de produção. Não prova ausência de
   * acesso à produção.
   */
  fingerprint?: string;
}

export interface StagingSecurityConfig {
  privileged?: boolean;
  /** `bridge` é o único modo aceito; `host` e `container:*` são recusados. */
  networkMode?: string;
  pidMode?: string;
  ipcMode?: string;
  dockerSocketMounted?: boolean;
  publicDomain?: string | null;
}

export interface StagingNetworkConfig {
  /** Nome pedido por configuração. O plano sempre gera um nome próprio. */
  name?: string;
  shared?: boolean;
}

export interface StagingProjectConfig {
  mode: StagingMode;
  ttlMinutes: number;
  /** Saída para internet desabilitada por padrão. */
  allowEgress?: boolean;
  app: StagingAppConfig;
  env?: StagingEnvBinding[];
  network?: StagingNetworkConfig;
  security?: StagingSecurityConfig;
}

export interface StagingDatabaseTarget {
  scheme: string;
  host: string;
  port: number;
  database?: string | null;
}

export interface StagingDependencyConfig {
  name: string;
  kind: StagingDependencyKind;
  /** Quando informado, precisa ser o MESMO projeto do plano. */
  projectId?: string;
  mode?: "ephemeral" | "external" | "file";
  envKey?: string;
  resources?: StagingResourceRequest;
  target?: StagingDatabaseTarget;
  mounts?: StagingMountConfig[];
  /** SHA-256 do segredo, quando aplicável; nunca o valor bruto. */
  secretFingerprint?: string;
  healthcheck?: string;
}

export interface StagingProductionContext {
  volumes: string[];
  networks: string[];
  databaseTargets: StagingDatabaseTarget[];
  secretFingerprints: string[];
  hostPorts?: number[];
}

export interface StagingHostCapacity {
  availableCpu: number;
  availableMemoryMb: number;
  freeDiskMb: number;
  activeEnvironments: number;
  maxConcurrentEnvironments: number;
  maxTtlMinutes: number;
  /** Candidatos fornecidos por um alocador; o plano NUNCA presume produção+1. */
  portCandidates: number[];
  unavailablePorts?: number[];
}

export interface StagingPlanInput {
  projectId: string;
  /** Identificador da execução (job/run). Nomes do plano derivam dele. */
  runId: string;
  config?: StagingProjectConfig | null;
  dependencies?: StagingDependencyConfig[];
  production?: StagingProductionContext;
  host?: StagingHostCapacity;
  /** Caminhos de bind explicitamente autorizados pelo operador. */
  authorizedBindMounts?: string[];
}

export interface StagingPlanMount {
  type: "volume" | "bind";
  source: string;
  target: string;
  readOnly: boolean;
}

export interface StagingPlanDependency {
  name: string;
  kind: SupportedStagingDependencyKind;
  mode: "ephemeral" | "external" | "file";
  serviceName: string | null;
  containerName: string | null;
  envKey: string | null;
  resources: StagingResourceRequest | null;
  volumeName: string | null;
  target: StagingDatabaseTarget | null;
  healthcheck: string | null;
}

export interface StagingPlan {
  mode: "isolated";
  projectId: string;
  runId: string;
  composeProject: string;
  ttlMinutes: number;
  network: {
    name: string;
    egressEnabled: boolean;
    sharedNetwork: false;
    publicDomain: null;
  };
  app: {
    containerName: string;
    hostPort: number;
    hostBind: string;
    memoryMb: number;
    cpu: number;
    diskMb: number;
    mounts: StagingPlanMount[];
  };
  dependencies: StagingPlanDependency[];
  volumes: string[];
  env: Array<{ key: string; source: "explicit" | "dependency" }>;
  resources: {
    memoryMb: number;
    cpu: number;
    diskMb: number;
    dependencyCount: number;
  };
  security: {
    sharedNetworkUsed: false;
    productionVolumeUsed: false;
    productionCredentialDetected: false;
    dockerSocketMounted: false;
    privileged: false;
    hostNetwork: false;
  };
  warnings: string[];
  /** A reserva real da porta deve ser atômica e feita na execução (P1). */
  requiresAtomicPortReservation: true;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEPENDENCY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_ENV_KEYS = new Set(["KORELO_DEPLOY_ENV"]);
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function normalizeTarget(target: StagingDatabaseTarget): {
  scheme: string;
  host: string;
  port: number;
  database: string | null;
} {
  const rawScheme = target.scheme.trim().toLowerCase();
  const scheme =
    rawScheme === "postgres"
      ? "postgresql"
      : rawScheme === "mongo"
        ? "mongodb"
        : rawScheme;
  return {
    scheme,
    host: target.host.trim().toLowerCase(),
    port: target.port,
    database: target.database?.trim().toLowerCase() || null,
  };
}

function targetKey(target: StagingDatabaseTarget | null | undefined): string {
  if (!target || typeof target !== "object") return "";
  if (typeof target.scheme !== "string" || typeof target.host !== "string") return "";
  if (!Number.isInteger(target.port) || target.port <= 0) return "";
  const normalized = normalizeTarget(target);
  return `${normalized.scheme}://${normalized.host}:${normalized.port}/${normalized.database ?? ""}`;
}

function legacyResult(): StagingValidationResult {
  return { ok: true, mode: "legacy", legacy: true, issues: [], plan: null };
}

/**
 * Planeja o staging. Função PURA: não toca em Docker, banco, filesystem,
 * rede ou processo. Toda a decisão vem dos parâmetros.
 */
export function planStaging(input: StagingPlanInput): StagingValidationResult {
  const config = input.config ?? null;
  // Compatibilidade absoluta: só o modo explícito "isolated" ativa validações.
  if (!config || config.mode === "legacy") return legacyResult();

  const issues: StagingValidationIssue[] = [];
  const add = (code: StagingValidationCode, field: string, message: string) => {
    issues.push({ code, field, message });
  };

  if (config.mode !== "isolated") {
    add("STAGING_MODE_INVALID", "config.mode", `Modo de staging inválido: "${String(config.mode)}".`);
    return { ok: false, mode: "isolated", legacy: false, issues, plan: null };
  }

  const projectSlug = slug(input.projectId);
  const runSlug = slug(input.runId);
  if (!projectSlug) add("STAGING_CONFIG_INCOMPLETE", "projectId", "projectId é obrigatório para o plano isolado.");
  if (!runSlug) add("STAGING_CONFIG_INCOMPLETE", "runId", "runId é obrigatório para o plano isolado.");

  const production = input.production;
  if (!production) {
    add(
      "STAGING_PRODUCTION_CONTEXT_MISSING",
      "production",
      "Contexto de produção é obrigatório para validar isolamento (volumes, redes, bancos e segredos).",
    );
  }
  const productionVolumes = new Set((production?.volumes ?? []).map((entry) => entry.trim()).filter(Boolean));
  const productionNetworks = new Set((production?.networks ?? []).map((entry) => entry.trim()).filter(Boolean));
  const productionFingerprints = new Set(
    (production?.secretFingerprints ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  const productionTargets = new Set(
    (production?.databaseTargets ?? []).map(targetKey).filter((key) => key.length > 0),
  );

  const app = config.app;
  let appMemoryMb = 0;
  let appCpu = 0;
  let appDiskMb = 0;
  if (!app) {
    add("STAGING_CONFIG_INCOMPLETE", "config.app", "Recursos explícitos do app de staging são obrigatórios.");
  } else {
    if (!isPositiveNumber(app.memoryMb)) {
      add("STAGING_CONFIG_INCOMPLETE", "config.app.memoryMb", "memoryMb do app precisa ser explícito e > 0.");
    } else {
      appMemoryMb = app.memoryMb;
    }
    if (!isPositiveNumber(app.cpu)) {
      add("STAGING_CONFIG_INCOMPLETE", "config.app.cpu", "cpu do app precisa ser explícita e > 0.");
    } else {
      appCpu = app.cpu;
    }
    if (!isPositiveNumber(app.diskMb)) {
      add("STAGING_CONFIG_INCOMPLETE", "config.app.diskMb", "diskMb do app precisa ser explícito e > 0.");
    } else {
      appDiskMb = app.diskMb;
    }
  }

  if (!isPositiveInteger(config.ttlMinutes)) {
    add("STAGING_TTL_INVALID", "config.ttlMinutes", "ttlMinutes precisa ser um inteiro > 0.");
  }

  const security = config.security ?? {};
  if (security.privileged === true) {
    add("STAGING_PRIVILEGED", "config.security.privileged", "Container privilegiado é proibido no staging isolado.");
  }
  if (security.dockerSocketMounted === true) {
    add("STAGING_DOCKER_SOCKET", "config.security.dockerSocketMounted", "Docker socket não pode ser montado no staging.");
  }
  if (security.networkMode !== undefined && security.networkMode !== "bridge") {
    if (security.networkMode === "host") {
      add("STAGING_HOST_NETWORK", "config.security.networkMode", "network_mode=host é proibido.");
    } else {
      add("STAGING_HOST_NETWORK", "config.security.networkMode", `network_mode "${security.networkMode}" não é suportado.`);
    }
  }
  if (security.pidMode === "host" || security.ipcMode === "host") {
    add("STAGING_UNSUPPORTED_NAMESPACE", "config.security", "Namespaces do host (pid/ipc) são proibidos.");
  }
  if (security.publicDomain && security.publicDomain.trim().length > 0) {
    add("STAGING_PUBLIC_EXPOSURE", "config.security.publicDomain", "Staging não pode publicar domínio público.");
  }

  if (config.network?.shared === true) {
    add("STAGING_SHARED_NETWORK", "config.network.shared", "Rede compartilhada de produção é proibida.");
  }
  if (config.network?.name) {
    const requested = config.network.name.trim();
    if (requested === "korrelo-shared") {
      add("STAGING_SHARED_NETWORK", "config.network.name", "A rede korrelo-shared é proibida no staging.");
    } else if (productionNetworks.has(requested)) {
      add("STAGING_PRODUCTION_NETWORK", "config.network.name", `A rede "${requested}" pertence à produção.`);
    }
  }

  const authorizedBinds = new Set((input.authorizedBindMounts ?? []).map((entry) => entry.trim()).filter(Boolean));
  const validateMounts = (
    mounts: StagingMountConfig[] | undefined,
    field: string,
    allowedVolumePrefix: string,
  ): void => {
    for (const [index, mount] of (mounts ?? []).entries()) {
      const mountField = `${field}[${index}]`;
      if (!mount || !mount.source?.trim() || !mount.target?.trim()) {
        add("STAGING_CONFIG_INCOMPLETE", mountField, "Mount precisa de source e target explícitos.");
        continue;
      }
      const source = mount.source.trim();
      const target = mount.target.trim();
      if (!target.startsWith("/")) {
        add("STAGING_CONFIG_INVALID", `${mountField}.target`, "target do mount precisa ser um caminho absoluto.");
      }
      if (source.includes("docker.sock") || source === DOCKER_SOCKET_PATH) {
        add("STAGING_DOCKER_SOCKET", `${mountField}.source`, "Docker socket não pode ser montado.");
        continue;
      }
      if (productionVolumes.has(source)) {
        add("STAGING_PRODUCTION_VOLUME", `${mountField}.source`, `Volume de produção "${source}" é proibido.`);
      }
      if (mount.type === "bind") {
        if (mount.authorized !== true || !authorizedBinds.has(source)) {
          add(
            "STAGING_BIND_MOUNT",
            `${mountField}.source`,
            `Bind mount "${source}" não foi autorizado explicitamente pelo operador.`,
          );
        }
        continue;
      }
      if (mount.type !== "volume") {
        add("STAGING_UNSUPPORTED_MOUNT", `${mountField}.type`, "Somente mounts volume/bind são suportados.");
        continue;
      }
      if (!source.startsWith(allowedVolumePrefix)) {
        add(
          "STAGING_PRODUCTION_VOLUME",
          `${mountField}.source`,
          `Volume "${source}" não segue o prefixo exclusivo do staging (${allowedVolumePrefix}...).`,
        );
      }
    }
  };

  const stagingVolumePrefix = `korrelo-stg-${projectSlug || "project"}-${runSlug || "run"}-`;
  if (app) {
    validateMounts(app.mounts, "config.app.mounts", stagingVolumePrefix);
  }

  const envKeys = new Map<string, string>();
  const registerEnv = (key: string, source: string, field: string, fingerprint?: string): void => {
    if (!ENV_KEY_PATTERN.test(key)) {
      add("STAGING_CONFIG_INVALID", field, `Nome de variável inválido: "${key}".`);
      return;
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      add("STAGING_RESERVED_ENV", field, `A variável ${key} é reservada pelo Korrelo.`);
      return;
    }
    if (envKeys.has(key)) {
      add("STAGING_DUPLICATE_ENV", field, `Variável "${key}" duplicada (já definida por ${envKeys.get(key)}).`);
      return;
    }
    envKeys.set(key, source);
    if (fingerprint && productionFingerprints.has(fingerprint.trim().toLowerCase())) {
      add(
        "STAGING_PRODUCTION_CREDENTIAL",
        field,
        `O segredo de "${key}" coincide com um segredo de produção.`,
      );
    }
  };

  for (const [index, binding] of (config.env ?? []).entries()) {
    registerEnv(binding.key, "explicit", `config.env[${index}]`, binding.fingerprint);
  }

  const dependencies = input.dependencies ?? [];
  const dependencyNames = new Set<string>();
  let dependencyMemoryMb = 0;
  let dependencyCpu = 0;
  let dependencyDiskMb = 0;
  const supportedKinds = new Set<string>(SUPPORTED_STAGING_DEPENDENCY_KINDS);

  for (const [index, dependency] of dependencies.entries()) {
    const field = `dependencies[${index}]`;
    const kind = String(dependency.kind ?? "").trim().toLowerCase();
    const name = String(dependency.name ?? "").trim().toLowerCase();

    if (!DEPENDENCY_NAME_PATTERN.test(name)) {
      add(
        "STAGING_CONFIG_INVALID",
        `${field}.name`,
        `Nome de dependência inválido: "${dependency.name}". Use letras minúsculas, números e hífen.`,
      );
    } else if (dependencyNames.has(name)) {
      add("STAGING_DUPLICATE_DEPENDENCY", `${field}.name`, `Dependência "${name}" duplicada.`);
    } else {
      dependencyNames.add(name);
    }

    if (dependency.projectId && dependency.projectId !== input.projectId) {
      add(
        "STAGING_DEPENDENCY_PROJECT_MISMATCH",
        `${field}.projectId`,
        "Dependência pertence a outro projeto; isolamento entre projetos seria violado.",
      );
    }

    if (!supportedKinds.has(kind)) {
      add(
        "STAGING_UNSUPPORTED_DEPENDENCY",
        `${field}.kind`,
        `Tipo de dependência não suportado nesta fase: "${dependency.kind}".`,
      );
      continue;
    }

    const supportedKind = kind as SupportedStagingDependencyKind;
    if (supportedKind === "external") {
      if (!dependency.target) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.target`, "Dependência externa exige target explícito.");
      } else {
        if (
          !dependency.target.scheme?.trim() ||
          !dependency.target.host?.trim() ||
          !isPositiveInteger(dependency.target.port)
        ) {
          add("STAGING_CONFIG_INVALID", `${field}.target`, "Target externo precisa de scheme, host e port.");
        } else if (productionTargets.has(targetKey(dependency.target))) {
          add(
            "STAGING_PRODUCTION_DATABASE",
            `${field}.target`,
            "Target externo coincide com um banco conhecido de produção.",
          );
        }
      }
      if (!dependency.envKey) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.envKey`, "Dependência externa exige envKey explícito.");
      } else {
        registerEnv(dependency.envKey, `dependency:${name}`, `${field}.envKey`, dependency.secretFingerprint);
      }
      if (!dependency.secretFingerprint) {
        add(
          "STAGING_CONFIG_INCOMPLETE",
          `${field}.secretFingerprint`,
          "Dependência externa exige um segredo de staging (fingerprint obrigatório para a checagem).",
        );
      }
      if (dependency.mounts && dependency.mounts.length > 0) {
        add("STAGING_UNSUPPORTED_MOUNT", `${field}.mounts`, "Dependência externa não aceita mounts locais.");
      }
      if (dependency.resources !== undefined) {
        add(
          "STAGING_CONFIG_INVALID",
          `${field}.resources`,
          "Dependência externa não consome recursos locais; remova resources.",
        );
      }
      continue;
    }

    if (supportedKind === "sqlite" && dependency.mode && dependency.mode !== "file") {
      add("STAGING_CONFIG_INVALID", `${field}.mode`, "SQLite em staging deve usar mode=file.");
    }
    if (supportedKind !== "sqlite" && dependency.mode === "external") {
      add(
        "STAGING_CONFIG_INVALID",
        `${field}.mode`,
        "Para banco externo use kind=external; containers gerenciados usam mode=ephemeral.",
      );
    }

    const resources = dependency.resources;
    if (!resources) {
      add("STAGING_CONFIG_INCOMPLETE", `${field}.resources`, "Recursos explícitos da dependência são obrigatórios.");
    } else {
      if (supportedKind === "sqlite") {
        if (!isNonNegativeNumber(resources.memoryMb) || !isNonNegativeNumber(resources.cpu)) {
          add(
            "STAGING_CONFIG_INVALID",
            `${field}.resources`,
            "SQLite não consome container; memoryMb/cpu devem ser 0 ou positivos explícitos.",
          );
        }
      } else if (!isPositiveNumber(resources.memoryMb) || !isPositiveNumber(resources.cpu)) {
        add(
          "STAGING_CONFIG_INCOMPLETE",
          `${field}.resources`,
          "memoryMb e cpu da dependência precisam ser explícitos e > 0.",
        );
      }
      if (!isPositiveNumber(resources.diskMb)) {
        add("STAGING_CONFIG_INCOMPLETE", `${field}.resources.diskMb`, "diskMb da dependência precisa ser > 0.");
      }
      dependencyMemoryMb += numberOrZero(resources.memoryMb);
      dependencyCpu += numberOrZero(resources.cpu);
      dependencyDiskMb += numberOrZero(resources.diskMb);
    }

    if (supportedKind !== "sqlite" && !dependency.envKey) {
      add("STAGING_CONFIG_INCOMPLETE", `${field}.envKey`, "Dependência gerenciada exige envKey explícito.");
    } else if (dependency.envKey) {
      registerEnv(dependency.envKey, `dependency:${name}`, `${field}.envKey`, dependency.secretFingerprint);
    }
    if (dependency.secretFingerprint && !dependency.envKey && productionFingerprints.has(dependency.secretFingerprint.trim().toLowerCase())) {
      add(
        "STAGING_PRODUCTION_CREDENTIAL",
        `${field}.secretFingerprint`,
        `O segredo da dependência "${name}" coincide com um segredo de produção.`,
      );
    }
    validateMounts(dependency.mounts, `${field}.mounts`, stagingVolumePrefix);
  }

  const host = input.host;
  if (!host) {
    add("STAGING_CONFIG_INCOMPLETE", "host", "Capacidade do host é obrigatória para validar o staging isolado.");
  } else {
    if (!isNonNegativeNumber(host.availableCpu)) {
      add("STAGING_CONFIG_INVALID", "host.availableCpu", "availableCpu deve ser >= 0.");
    }
    if (!isNonNegativeNumber(host.availableMemoryMb)) {
      add("STAGING_CONFIG_INVALID", "host.availableMemoryMb", "availableMemoryMb deve ser >= 0.");
    }
    if (!isNonNegativeNumber(host.freeDiskMb)) {
      add("STAGING_CONFIG_INVALID", "host.freeDiskMb", "freeDiskMb deve ser >= 0.");
    }
    if (!isPositiveInteger(host.maxConcurrentEnvironments)) {
      add("STAGING_CONFIG_INVALID", "host.maxConcurrentEnvironments", "maxConcurrentEnvironments deve ser > 0.");
    }
    if (!isNonNegativeNumber(host.activeEnvironments) || !Number.isInteger(host.activeEnvironments)) {
      add("STAGING_CONFIG_INVALID", "host.activeEnvironments", "activeEnvironments deve ser inteiro >= 0.");
    } else if (
      isPositiveInteger(host.maxConcurrentEnvironments) &&
      host.activeEnvironments >= host.maxConcurrentEnvironments
    ) {
      add(
        "STAGING_CONCURRENCY_LIMIT",
        "host.activeEnvironments",
        `Limite de ambientes simultâneos atingido (${host.activeEnvironments}/${host.maxConcurrentEnvironments}).`,
      );
    }
    if (!isPositiveInteger(host.maxTtlMinutes)) {
      add("STAGING_CONFIG_INVALID", "host.maxTtlMinutes", "maxTtlMinutes deve ser > 0.");
    } else if (isPositiveInteger(config.ttlMinutes) && config.ttlMinutes > host.maxTtlMinutes) {
      add(
        "STAGING_TTL_INVALID",
        "config.ttlMinutes",
        `ttlMinutes (${config.ttlMinutes}) excede o máximo permitido (${host.maxTtlMinutes}).`,
      );
    }
  }

  const totalMemoryMb = appMemoryMb + dependencyMemoryMb;
  const totalCpu = appCpu + dependencyCpu;
  const totalDiskMb = appDiskMb + dependencyDiskMb;
  if (host) {
    if (isNonNegativeNumber(host.availableMemoryMb) && totalMemoryMb > host.availableMemoryMb) {
      add(
        "STAGING_RESOURCE_MEMORY",
        "resources.memoryMb",
        `Memória insuficiente: plano ${totalMemoryMb} MB, disponível ${host.availableMemoryMb} MB.`,
      );
    }
    if (isNonNegativeNumber(host.availableCpu) && totalCpu > host.availableCpu) {
      add(
        "STAGING_RESOURCE_CPU",
        "resources.cpu",
        `CPU insuficiente: plano ${totalCpu}, disponível ${host.availableCpu}.`,
      );
    }
    if (isNonNegativeNumber(host.freeDiskMb) && totalDiskMb > host.freeDiskMb) {
      add(
        "STAGING_RESOURCE_DISK",
        "resources.diskMb",
        `Disco insuficiente: plano ${totalDiskMb} MB, disponível ${host.freeDiskMb} MB.`,
      );
    }
  }

  let hostPort: number | null = null;
  if (!host || !Array.isArray(host.portCandidates)) {
    add("STAGING_PORT_CONFLICT", "host.portCandidates", "Nenhum candidato de porta foi fornecido.");
  } else {
    const blocked = new Set<number>([
      ...(host.unavailablePorts ?? []),
      ...(production?.hostPorts ?? []),
    ]);
    hostPort =
      host.portCandidates.find(
        (candidate) =>
          Number.isInteger(candidate) &&
          candidate >= 1024 &&
          candidate <= 65535 &&
          !blocked.has(candidate),
      ) ?? null;
    if (hostPort === null) {
      add(
        "STAGING_PORT_CONFLICT",
        "host.portCandidates",
        "Nenhuma porta candidata está livre para o staging (conflito ou faixa inválida).",
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, mode: "isolated", legacy: false, issues, plan: null };
  }

  // A partir daqui todas as entradas críticas foram validadas.
  const composeProject = `korrelo-stg-${projectSlug.slice(0, 20)}-${runSlug.slice(0, 12)}`;
  const networkName = `${composeProject}-net`;
  const uploadsVolume = `${stagingVolumePrefix}uploads`;

  const dependencyPlans: StagingPlanDependency[] = dependencies.map((dependency) => {
    const kind = String(dependency.kind).trim().toLowerCase() as SupportedStagingDependencyKind;
    const name = String(dependency.name).trim().toLowerCase();
    const isExternal = kind === "external";
    const isFile = kind === "sqlite";
    const serviceName = isExternal ? null : `stg-${name}`;
    return {
      name,
      kind,
      mode: isExternal ? "external" : isFile ? "file" : "ephemeral",
      serviceName,
      containerName: isExternal ? null : `${composeProject}-${name}`,
      envKey: dependency.envKey ?? null,
      resources: isExternal ? null : dependency.resources!,
      volumeName: isExternal ? null : `${stagingVolumePrefix}${name}-data`,
      target: isExternal ? normalizeTarget(dependency.target!) : null,
      healthcheck: dependency.healthcheck ?? null,
    };
  });

  const volumes = new Set<string>([uploadsVolume]);
  for (const dependency of dependencyPlans) {
    if (dependency.volumeName) volumes.add(dependency.volumeName);
  }

  const appMounts: StagingPlanMount[] = [
    { type: "volume", source: uploadsVolume, target: "/app/uploads", readOnly: false },
    ...(app?.mounts ?? []).map((mount) => ({
      type: mount.type,
      source: mount.source.trim(),
      target: mount.target.trim(),
      readOnly: mount.readOnly === true,
    })),
  ];

  const env: Array<{ key: string; source: "explicit" | "dependency" }> = [];
  for (const binding of config.env ?? []) env.push({ key: binding.key, source: "explicit" });
  for (const dependency of dependencyPlans) {
    if (dependency.envKey) env.push({ key: dependency.envKey, source: "dependency" });
  }

  const warnings = [
    "A checagem por fingerprint detecta reutilização exata de segredo, mas não prova ausência de acesso à produção.",
    "A porta retornada é uma reserva de planejamento; a reserva real deve ser atômica na execução.",
  ];
  if (config.allowEgress === true) {
    warnings.push("Egress habilitado explicitamente; não há allowlist de domínio nesta fase.");
  }

  return {
    ok: true,
    mode: "isolated",
    legacy: false,
    issues: [],
    plan: {
      mode: "isolated",
      projectId: input.projectId,
      runId: input.runId,
      composeProject,
      ttlMinutes: config.ttlMinutes,
      network: {
        name: networkName,
        egressEnabled: config.allowEgress === true,
        sharedNetwork: false,
        publicDomain: null,
      },
      app: {
        containerName: `${composeProject}-app`,
        hostPort: hostPort!,
        hostBind: `127.0.0.1:${hostPort}`,
        memoryMb: app!.memoryMb,
        cpu: app!.cpu,
        diskMb: app!.diskMb,
        mounts: appMounts,
      },
      dependencies: dependencyPlans,
      volumes: [...volumes],
      env,
      resources: {
        memoryMb: totalMemoryMb,
        cpu: totalCpu,
        diskMb: totalDiskMb,
        dependencyCount: dependencyPlans.length,
      },
      security: {
        sharedNetworkUsed: false,
        productionVolumeUsed: false,
        productionCredentialDetected: false,
        dockerSocketMounted: false,
        privileged: false,
        hostNetwork: false,
      },
      warnings,
      requiresAtomicPortReservation: true,
    },
  };
}

/**
 * Serviço de domínio sem dependências de Nest/Docker. Pode ser injetado
 * futuramente sem alterar o fluxo de deploy atual.
 */
export class StagingPlanner {
  plan(input: StagingPlanInput): StagingValidationResult {
    return planStaging(input);
  }
}
