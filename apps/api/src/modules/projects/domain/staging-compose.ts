import type { StagingPlan } from "./staging-planner";
import {
  hashStagingCompose,
  hashStagingPlan,
  stableStringify,
} from "./staging-plan-hash";

/**
 * P1C — COMPOSE DE STAGING ISOLADO (DRY-RUN).
 *
 * O gerador produz um modelo canônico e um JSON determinístico. Nenhum
 * arquivo é escrito, nenhum Docker é chamado e nenhum valor secreto entra
 * no modelo ou nos hashes.
 *
 * O JSON é a representação normalizada usada para composeHash. A execução
 * futura pode renderizá-lo em YAML sem interpolação de strings não validadas.
 */

export interface StagingComposeHealthcheck {
  test: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  startPeriodSeconds: number;
}

export interface StagingComposeRequest {
  plan: StagingPlan;
  containerPort: number;
  pidsLimit: number;
  /** Exatamente um entre imageReference e buildContext. */
  imageReference?: string | null;
  buildContext?: string | null;
  dockerfile?: string | null;
  deployJobId?: string | null;
  healthcheck?: StagingComposeHealthcheck | null;
  /** Imagens explícitas por nome de dependência; necessárias para banco local. */
  dependencyImages?: Record<string, string>;
  /** Arquivo de env do app (nome relativo seguro, gerado pelo executor). */
  appEnvFile?: string | null;
  /** Arquivo de env por NOME da dependência. */
  dependencyEnvFiles?: Record<string, string>;
  /** Healthcheck CMD-SHELL por NOME da dependência. */
  dependencyHealthchecks?: Record<string, string>;
  authorizedBindMounts?: string[];
}

export interface StagingComposeService {
  container_name: string;
  image?: string;
  build?: { context: string; dockerfile: string };
  restart: "no";
  networks: string[];
  ports?: string[];
  volumes?: string[];
  mem_limit: string;
  cpus: number;
  pids_limit: number;
  labels: Record<string, string>;
  environment?: Record<string, string>;
  env_file?: string[];
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
  depends_on?: string[] | Record<string, { condition: "service_started" | "service_healthy" }>;
  security_opt: string[];
  cap_drop: string[];
  cap_add?: string[];
  logging: { driver: "json-file"; options: { "max-size": string; "max-file": string } };
}

export interface StagingComposeNetwork {
  name: string;
  internal: boolean;
  labels: Record<string, string>;
}

export interface StagingComposeVolume {
  name: string;
  labels: Record<string, string>;
}

export interface StagingComposeDocument {
  name: string;
  services: Record<string, StagingComposeService>;
  networks: Record<string, StagingComposeNetwork>;
  volumes: Record<string, StagingComposeVolume>;
}

export interface StagingComposeModel extends StagingComposeDocument {
  planHash: string;
  environmentReferences: Array<{ key: string; source: "explicit" | "dependency" }>;
}

export interface StagingComposeIssue {
  code: string;
  field: string;
  message: string;
}

export interface StagingComposeResult {
  ok: boolean;
  planHash: string | null;
  composeHash: string | null;
  model: StagingComposeModel | null;
  /** Documento executável; não contém planHash/environmentReferences. */
  document: StagingComposeDocument | null;
  serialized: string | null;
  issues: StagingComposeIssue[];
}

/** Gera o modelo canônico; nunca executa ou escreve nada. */
export function generateStagingCompose(request: StagingComposeRequest): StagingComposeResult {
  const issues: StagingComposeIssue[] = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message });
  const plan = request.plan;
  if (!plan) {
    add("STAGING_COMPOSE_PLAN_REQUIRED", "plan", "Plano de staging é obrigatório.");
    return failure(issues);
  }
  if (plan.mode !== "isolated") {
    add("STAGING_COMPOSE_PLAN_INVALID", "plan.mode", "Somente plano isolated pode gerar compose de staging.");
  }
  if (!plan.projectId || !plan.runId || !plan.composeProject) {
    add("STAGING_COMPOSE_PLAN_INVALID", "plan.identity", "Plano precisa de projectId, runId e composeProject.");
  }
  if (plan.network.sharedNetwork !== false || plan.network.publicDomain !== null) {
    add("STAGING_COMPOSE_NETWORK_INVALID", "plan.network", "Plano não está isolado de rede pública/compartilhada.");
  }
  if (
    plan.security.sharedNetworkUsed ||
    plan.security.productionVolumeUsed ||
    plan.security.productionCredentialDetected ||
    plan.security.dockerSocketMounted ||
    plan.security.privileged ||
    plan.security.hostNetwork
  ) {
    add("STAGING_COMPOSE_SECURITY_INVALID", "plan.security", "Plano contém uma proteção de isolamento violada.");
  }
  if (!Number.isInteger(request.containerPort) || request.containerPort <= 0 || request.containerPort > 65535) {
    add("STAGING_COMPOSE_PORT_INVALID", "containerPort", "containerPort precisa ser inteiro entre 1 e 65535.");
  }
  if (!Number.isInteger(request.pidsLimit) || request.pidsLimit <= 0) {
    add("STAGING_COMPOSE_PIDS_INVALID", "pidsLimit", "pidsLimit precisa ser inteiro > 0.");
  }
  if (!plan.app || !isPositive(plan.app.memoryMb) || !isPositive(plan.app.cpu) || !isPositive(plan.app.diskMb)) {
    add("STAGING_COMPOSE_RESOURCE_INVALID", "plan.app", "Recursos do app precisam ser explícitos e positivos.");
  }
  if (!isLoopbackPort(plan.app?.hostBind, plan.app?.hostPort)) {
    add("STAGING_COMPOSE_PORT_INVALID", "plan.app.hostBind", "A porta do staging precisa ser loopback 127.0.0.1.");
  }

  const hasImage = typeof request.imageReference === "string" && request.imageReference.trim().length > 0;
  const hasBuild = typeof request.buildContext === "string" && request.buildContext.trim().length > 0;
  if (hasImage === hasBuild) {
    add(
      "STAGING_COMPOSE_SOURCE_INVALID",
      "imageReference/buildContext",
      "Informe exatamente uma referência de imagem ou contexto de build.",
    );
  }
  if (hasImage && !isSafeImageReference(request.imageReference!)) {
    add("STAGING_COMPOSE_IMAGE_INVALID", "imageReference", "Referência de imagem inválida.");
  }
  if (hasBuild && !isSafeBuildContext(request.buildContext!)) {
    add("STAGING_COMPOSE_BUILD_INVALID", "buildContext", "Contexto de build precisa ser relativo e seguro.");
  }
  if (request.dockerfile && !isSafeRelativePath(request.dockerfile)) {
    add("STAGING_COMPOSE_BUILD_INVALID", "dockerfile", "Dockerfile precisa ser caminho relativo seguro.");
  }
  if (request.healthcheck) validateHealthcheck(request.healthcheck, add);
  if (!plan.app?.containerName) {
    add("STAGING_COMPOSE_PLAN_INVALID", "plan.app.containerName", "containerName do app é obrigatório.");
  }
  if (!Array.isArray(plan.volumes) || plan.volumes.length === 0) {
    add("STAGING_COMPOSE_PLAN_INVALID", "plan.volumes", "O plano precisa declarar volumes temporários.");
  }

  const prefix = stagingVolumePrefix(plan);
  for (const volume of plan.volumes ?? []) {
    if (!volume.startsWith(prefix)) {
      add("STAGING_COMPOSE_VOLUME_INVALID", `volumes.${volume}`, "Volume fora do prefixo exclusivo do staging.");
    }
    if (volume === "uploads-data" || volume.includes("korrelo-shared")) {
      add("STAGING_COMPOSE_PRODUCTION_VOLUME", `volumes.${volume}`, "Volume de produção é proibido.");
    }
  }
  if (!plan.network.name?.startsWith("korrelo-stg-")) {
    add("STAGING_COMPOSE_NETWORK_INVALID", "plan.network.name", "Rede precisa ter prefixo exclusivo de staging.");
  }
  if (plan.network.name === "korrelo-shared") {
    add("STAGING_COMPOSE_NETWORK_INVALID", "plan.network.name", "Rede compartilhada é proibida.");
  }

  const authorizedBinds = new Set((request.authorizedBindMounts ?? []).map((entry) => entry.trim()).filter(Boolean));
  const appMounts = (plan.app?.mounts ?? []).map((mount) => {
    if (mount.type === "bind") {
      if (!authorizedBinds.has(mount.source)) {
        add("STAGING_COMPOSE_BIND_MOUNT", `app.mounts.${mount.source}`, "Bind mount não autorizado.");
      }
      if (mount.source.includes("docker.sock")) {
        add("STAGING_COMPOSE_DOCKER_SOCKET", `app.mounts.${mount.source}`, "Docker socket é proibido.");
      }
    } else if (mount.type !== "volume") {
      add("STAGING_COMPOSE_MOUNT_INVALID", `app.mounts.${mount.source}`, "Tipo de mount não suportado.");
    } else if (!plan.volumes.includes(mount.source)) {
      add("STAGING_COMPOSE_MOUNT_INVALID", `app.mounts.${mount.source}`, "Volume do mount não pertence ao plano.");
    }
    return `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`;
  });

  const localDependencies = (plan.dependencies ?? []).filter(
    (dependency) => dependency.mode === "ephemeral" || dependency.mode === "file",
  );
  const dependencyServices: Record<string, StagingComposeService> = {};
  for (const dependency of localDependencies) {
    if (dependency.mode === "file") {
      if (!dependency.volumeName || !plan.volumes.includes(dependency.volumeName)) {
        add("STAGING_COMPOSE_DEPENDENCY_INVALID", `dependencies.${dependency.name}`, "SQLite exige volume declarado.");
      }
      continue;
    }
    const image = request.dependencyImages?.[dependency.name];
    if (!image) {
      add(
        "STAGING_COMPOSE_DEPENDENCY_IMAGE_REQUIRED",
        `dependencies.${dependency.name}.image`,
        "Imagem explícita é obrigatória para dependência local nesta fase.",
      );
      continue;
    }
    if (!isSafeImageReference(image)) {
      add("STAGING_COMPOSE_DEPENDENCY_INVALID", `dependencies.${dependency.name}.image`, "Imagem de dependência inválida.");
      continue;
    }
    if (!dependency.serviceName || !dependency.containerName || !dependency.resources) {
      add("STAGING_COMPOSE_DEPENDENCY_INVALID", `dependencies.${dependency.name}`, "Dependência local incompleta.");
      continue;
    }
    if (!isPositive(dependency.resources.memoryMb) || !isPositive(dependency.resources.cpu)) {
      add("STAGING_COMPOSE_DEPENDENCY_INVALID", `dependencies.${dependency.name}.resources`, "Recursos inválidos.");
      continue;
    }
    const mountPath = dependencyMountPath(dependency.kind);
    if (!mountPath) {
      add("STAGING_COMPOSE_DEPENDENCY_INVALID", `dependencies.${dependency.name}`, "Tipo de banco não suportado no Compose.");
      continue;
    }
    const dependencyCaps = dependencyCapabilities(dependency.kind);
    dependencyServices[dependency.serviceName] = {
      container_name: dependency.containerName,
      image,
      restart: "no",
      networks: ["internal"],
      volumes: dependency.volumeName ? [`${dependency.volumeName}:${mountPath}`] : undefined,
      mem_limit: `${dependency.resources.memoryMb}m`,
      cpus: dependency.resources.cpu,
      pids_limit: request.pidsLimit,
      labels: ownershipLabels(plan, request),
      ...(request.dependencyEnvFiles?.[dependency.name]
        ? { env_file: [request.dependencyEnvFiles[dependency.name]] }
        : {}),
      ...(request.dependencyHealthchecks?.[dependency.name]
        ? { healthcheck: normalizeDependencyHealthcheck(request.dependencyHealthchecks[dependency.name]) }
        : {}),
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      ...(dependencyCaps ? { cap_add: dependencyCaps } : {}),
      logging: loggingConfig(),
    };
  }

  if (issues.length > 0) return failure(issues);

  const planHash = hashStagingPlan(plan);
  const appService: StagingComposeService = {
    container_name: plan.app.containerName,
    ...(hasImage ? { image: request.imageReference!.trim() } : {}),
    ...(hasBuild
      ? {
          build: {
            context: request.buildContext!.trim(),
            dockerfile: request.dockerfile?.trim() || "Dockerfile",
          },
        }
      : {}),
    restart: "no",
    networks: plan.network.egressEnabled ? ["internal", "egress"] : ["internal"],
    ports: [`${plan.app.hostBind}:${request.containerPort}`],
    volumes: appMounts,
    mem_limit: `${plan.app.memoryMb}m`,
    cpus: plan.app.cpu,
    pids_limit: request.pidsLimit,
    labels: ownershipLabels(plan, request),
    environment: { KORRELO_DEPLOY_ENV: "staging" },
    ...(request.appEnvFile ? { env_file: [request.appEnvFile] } : {}),
    ...(request.healthcheck ? { healthcheck: normalizeHealthcheck(request.healthcheck) } : {}),
    ...(Object.keys(dependencyServices).length > 0
      ? Object.values(dependencyServices).some((service) => service.healthcheck)
        ? {
            depends_on: Object.fromEntries(
              Object.keys(dependencyServices).map((serviceName) => [
                serviceName,
                {
                  condition: dependencyServices[serviceName].healthcheck
                    ? ("service_healthy" as const)
                    : ("service_started" as const),
                },
              ]),
            ),
          }
        : { depends_on: Object.keys(dependencyServices) }
      : {}),
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
    logging: loggingConfig(),
  };

  const model: StagingComposeModel = {
    name: plan.composeProject,
    planHash,
    services: {
      app_staging: appService,
      ...dependencyServices,
    },
    networks: {
      internal: {
        name: plan.network.name,
        internal: true,
        labels: ownershipLabels(plan, request),
      },
      ...(plan.network.egressEnabled
        ? {
            egress: {
              name: `${plan.network.name}-egress`,
              internal: false,
              labels: ownershipLabels(plan, request),
            },
          }
        : {}),
    },
    volumes: Object.fromEntries(
      plan.volumes.map((volume) => [
        volume,
        { name: volume, labels: ownershipLabels(plan, request) },
      ]),
    ),
    environmentReferences: plan.env.map((entry) => ({ key: entry.key, source: entry.source })),
  };

  const validation = validateStagingCompose(model, plan, request);
  if (!validation.ok) return failure(validation.issues);
  const document = toStagingComposeDocument(model);
  const serialized = stableStringify(document);
  const composeHash = hashStagingCompose(serialized);
  return { ok: true, planHash, composeHash, model, document, serialized, issues: [] };
}

export function toStagingComposeDocument(model: StagingComposeModel): StagingComposeDocument {
  return {
    name: model.name,
    services: model.services,
    networks: model.networks,
    volumes: model.volumes,
  };
}

/** Validação pós-geração; também pode ser usada contra um modelo recebido. */
export function validateStagingCompose(
  model: StagingComposeModel,
  plan: StagingPlan,
  request: Pick<StagingComposeRequest, "containerPort" | "deployJobId" | "authorizedBindMounts"> = {
    containerPort: 0,
    authorizedBindMounts: [],
  },
): { ok: boolean; issues: StagingComposeIssue[] } {
  const issues: StagingComposeIssue[] = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message });
  if (model.name !== plan.composeProject) add("STAGING_COMPOSE_NAME_MISMATCH", "name", "Compose project diverge do plano.");
  if (model.services.app) add("STAGING_COMPOSE_PRODUCTION_SERVICE", "services.app", "Serviço de produção é proibido.");
  if (model.planHash !== hashStagingPlan(plan)) add("STAGING_COMPOSE_PLAN_HASH", "planHash", "planHash não corresponde ao plano.");
  const authorizedBinds = new Set((request.authorizedBindMounts ?? []).map((entry) => entry.trim()).filter(Boolean));
  const allowedServices = new Set([
    "app_staging",
    ...(plan.dependencies ?? [])
      .filter((dependency) => dependency.mode === "ephemeral" && dependency.serviceName)
      .map((dependency) => dependency.serviceName as string),
  ]);
  const allowedNetworks = new Set(["internal", ...(plan.network.egressEnabled ? ["egress"] : [])]);
  const allowedVolumes = new Set(plan.volumes);
  for (const key of Object.keys(model.services)) {
    if (!allowedServices.has(key)) {
      add("STAGING_COMPOSE_EXTRA_SERVICE", `services.${key}`, "Serviço não autorizado pelo plano.");
    }
  }
  for (const key of Object.keys(model.networks)) {
    if (!allowedNetworks.has(key)) add("STAGING_COMPOSE_EXTRA_NETWORK", `networks.${key}`, "Rede não autorizada pelo plano.");
  }
  for (const key of Object.keys(model.volumes)) {
    if (!allowedVolumes.has(key)) add("STAGING_COMPOSE_EXTRA_VOLUME", `volumes.${key}`, "Volume não autorizado pelo plano.");
  }
  const app = model.services.app_staging;
  if (!app) add("STAGING_COMPOSE_APP_MISSING", "services.app_staging", "Serviço app_staging ausente.");
  else {
    if (!app.ports || app.ports.length !== 1 || !app.ports[0].startsWith("127.0.0.1:")) {
      add("STAGING_COMPOSE_PUBLIC_PORT", "services.app_staging.ports", "Somente uma porta loopback é permitida.");
    }
    if (!app.labels["korrelo.projectId"] || app.labels["korrelo.projectId"] !== plan.projectId) {
      add("STAGING_COMPOSE_OWNERSHIP", "services.app_staging.labels", "Label de projeto ausente/divergente.");
    }
    if (app.labels["korrelo.stagingRunId"] !== plan.runId || app.labels["korrelo.ephemeral"] !== "true") {
      add("STAGING_COMPOSE_OWNERSHIP", "services.app_staging.labels", "Labels de run/ephemeral ausentes/divergentes.");
    }
    if (app.labels["com.docker.compose.project"] !== plan.composeProject) {
      add("STAGING_COMPOSE_OWNERSHIP", "services.app_staging.labels", "Label de projeto Compose ausente/divergente.");
    }
    if (request.deployJobId && app.labels["korrelo.deployJobId"] !== request.deployJobId) {
      add("STAGING_COMPOSE_OWNERSHIP", "services.app_staging.labels", "Label de job ausente/divergente.");
    }
    if (app.environment && app.environment.KORRELO_DEPLOY_ENV !== "staging") {
      add("STAGING_COMPOSE_ENV", "services.app_staging.environment", "Ambiente de deploy inválido.");
    }
    if (app.image && app.build) add("STAGING_COMPOSE_SOURCE_INVALID", "services.app_staging", "Imagem e build não podem coexistir.");
  }
  for (const [key, service] of Object.entries(model.services)) {
    if (key === appKey(plan)) {
      // app já validado acima
    } else if (service.labels["korrelo.projectId"] !== plan.projectId) {
      add("STAGING_COMPOSE_OWNERSHIP", `services.${key}.labels`, "Label de projeto ausente/divergente.");
    }
    if (service.labels["korrelo.stagingRunId"] !== plan.runId || service.labels["korrelo.ephemeral"] !== "true") {
      add("STAGING_COMPOSE_OWNERSHIP", `services.${key}.labels`, "Labels de run/ephemeral ausentes/divergentes.");
    }
    if (request.deployJobId && service.labels["korrelo.deployJobId"] !== request.deployJobId) {
      add("STAGING_COMPOSE_OWNERSHIP", `services.${key}.labels`, "Label de job ausente/divergente.");
    }
    if (service.environment && Object.keys(service.environment).some((envKey) => envKey !== "KORRELO_DEPLOY_ENV")) {
      add("STAGING_COMPOSE_ENV", `services.${key}.environment`, "Compose não pode conter valores de ambiente arbitrários.");
    }
    for (const envFile of service.env_file ?? []) {
      if (!isSafeEnvFileName(envFile)) {
        add("STAGING_COMPOSE_ENV", `services.${key}.env_file`, "env_file precisa ser nome relativo seguro.");
      }
    }
    if ((service as unknown as { privileged?: unknown }).privileged === true) {
      add("STAGING_COMPOSE_PRIVILEGED", `services.${key}`, "privileged é proibido.");
    }
    if ((service as unknown as { network_mode?: unknown }).network_mode) {
      add("STAGING_COMPOSE_HOST_NETWORK", `services.${key}`, "network_mode é proibido.");
    }
    if ((service as unknown as { pid?: unknown }).pid === "host" || (service as unknown as { ipc?: unknown }).ipc === "host") {
      add("STAGING_COMPOSE_NAMESPACE", `services.${key}`, "Namespace do host é proibido.");
    }
    for (const volume of service.volumes ?? []) {
      const source = volume.split(":")[0];
      if (source.includes("docker.sock")) add("STAGING_COMPOSE_DOCKER_SOCKET", `services.${key}.volumes`, "Docker socket é proibido.");
      if (!model.volumes[source] && !authorizedBinds.has(source)) {
        add("STAGING_COMPOSE_MOUNT_INVALID", `services.${key}.volumes`, "Mount não autorizado no plano/modelo.");
      }
    }
  }
  for (const [key, network] of Object.entries(model.networks)) {
    if (network.name === "korrelo-shared" || network.name.includes("produ")) {
      add("STAGING_COMPOSE_SHARED_NETWORK", `networks.${key}`, "Rede compartilhada/produção é proibida.");
    }
    if (!network.name.startsWith("korrelo-stg-")) {
      add("STAGING_COMPOSE_NETWORK_INVALID", `networks.${key}`, "Rede sem prefixo exclusivo de staging.");
    }
  }
  for (const [key, volume] of Object.entries(model.volumes)) {
    if (volume.name === "uploads-data" || volume.name.includes("korrelo-shared")) {
      add("STAGING_COMPOSE_PRODUCTION_VOLUME", `volumes.${key}`, "Volume de produção é proibido.");
    }
    if (!volume.name.startsWith("korrelo-stg-")) {
      add("STAGING_COMPOSE_VOLUME_INVALID", `volumes.${key}`, "Volume sem prefixo exclusivo de staging.");
    }
  }
  const planEnvKeys = new Set((plan.env ?? []).map((entry) => `${entry.key}:${entry.source}`));
  for (const reference of model.environmentReferences) {
    if (!planEnvKeys.has(`${reference.key}:${reference.source}`)) {
      add("STAGING_COMPOSE_ENV", "environmentReferences", "Referência de ambiente não autorizada pelo plano.");
    }
  }
  for (const [key, service] of Object.entries(model.services)) {
    if (service.ports && key !== appKey(plan)) {
      add("STAGING_COMPOSE_PUBLIC_PORT", "services", "Dependências não podem publicar portas.");
    }
  }
  const recomputed = hashStagingCompose(stableStringify(model));
  if (model.planHash === "" || recomputed.length !== 64) {
    add("STAGING_COMPOSE_HASH_INVALID", "composeHash", "Hash do Compose inválido.");
  }
  return { ok: issues.length === 0, issues };
}

function appKey(_plan: StagingPlan): string {
  return "app_staging";
}

export function serializeStagingCompose(document: StagingComposeDocument): string {
  return stableStringify(document);
}

function failure(issues: StagingComposeIssue[]): StagingComposeResult {
  return { ok: false, planHash: null, composeHash: null, model: null, document: null, serialized: null, issues };
}

export function stagingVolumePrefix(plan: StagingPlan): string {
  return `korrelo-stg-${slug(plan.projectId)}-${slug(plan.runId)}-`;
}

function slug(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function ownershipLabels(plan: StagingPlan, request: Pick<StagingComposeRequest, "deployJobId">): Record<string, string> {
  return {
    "korrelo.projectId": plan.projectId,
    "korrelo.stagingRunId": plan.runId,
    "korrelo.ephemeral": "true",
    "korrelo.planHash": hashStagingPlan(plan),
    ...(request.deployJobId ? { "korrelo.deployJobId": request.deployJobId } : {}),
    "com.docker.compose.project": plan.composeProject,
  };
}

function loggingConfig() {
  return { driver: "json-file" as const, options: { "max-size": "10m", "max-file": "3" } };
}

function isSafeEnvFileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.includes("..");
}

function dependencyCapabilities(kind: string): string[] | null {
  if (kind === "mongodb" || kind === "postgres" || kind === "mysql") {
    return ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"];
  }
  return null;
}

function normalizeDependencyHealthcheck(command: string) {
  return {
    test: ["CMD-SHELL", command],
    interval: "5s",
    timeout: "5s",
    retries: 20,
    start_period: "10s",
  };
}

function normalizeHealthcheck(healthcheck: StagingComposeHealthcheck) {
  return {
    test: [...healthcheck.test],
    interval: `${Math.max(1, healthcheck.intervalSeconds)}s`,
    timeout: `${Math.max(1, healthcheck.timeoutSeconds)}s`,
    retries: Math.max(1, healthcheck.retries),
    start_period: `${Math.max(0, healthcheck.startPeriodSeconds)}s`,
  };
}

function validateHealthcheck(
  healthcheck: StagingComposeHealthcheck,
  add: (code: string, field: string, message: string) => void,
): void {
  if (!Array.isArray(healthcheck.test) || healthcheck.test.length === 0) {
    add("STAGING_COMPOSE_HEALTHCHECK_INVALID", "healthcheck.test", "Healthcheck precisa de comando explícito.");
  }
  for (const [index, part] of (healthcheck.test ?? []).entries()) {
    if (typeof part !== "string" || part.includes("\n") || part.includes("\0")) {
      add("STAGING_COMPOSE_HEALTHCHECK_INVALID", `healthcheck.test[${index}]`, "Comando de healthcheck inválido.");
    }
  }
  for (const [field, value, min] of [
    ["intervalSeconds", healthcheck.intervalSeconds, 1],
    ["timeoutSeconds", healthcheck.timeoutSeconds, 1],
    ["retries", healthcheck.retries, 1],
    ["startPeriodSeconds", healthcheck.startPeriodSeconds, 0],
  ] as const) {
    if (!Number.isInteger(value) || value < min) {
      add("STAGING_COMPOSE_HEALTHCHECK_INVALID", `healthcheck.${field}`, "Valor de healthcheck inválido.");
    }
  }
}

function isLoopbackPort(hostBind: string | undefined, hostPort: number): boolean {
  return hostBind === `127.0.0.1:${hostPort}` && Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535;
}

function isSafeImageReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(value.trim());
}

function isSafeBuildContext(value: string): boolean {
  return isSafeRelativePath(value) && value.trim() !== "";
}

function isSafeRelativePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return false;
  return !trimmed.split(/[\\/]/).some((part) => part === ".." || part === "");
}

function dependencyMountPath(kind: string): string | null {
  if (kind === "postgres") return "/var/lib/postgresql/data";
  if (kind === "mongodb") return "/data/db";
  if (kind === "mysql") return "/var/lib/mysql";
  if (kind === "redis") return "/data";
  return null;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
