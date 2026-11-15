import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as net from "node:net";
import { runCommand } from "../../../infrastructure/command-runner";
import type { ManagedDatabase } from "../domain/managed-database.entity";
import { MANAGED_DATABASE_REPOSITORY, type ManagedDatabaseRepository } from "../domain/managed-database.repository";
import type { EnvVar } from "../domain/env-var.entity";
import { ENV_VAR_REPOSITORY, type EnvVarRepository } from "../domain/env-var.repository";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { readHostResources, realHostResourceProvider } from "../../../infrastructure/host-resources";
import {
  STAGING_HOST_METRICS,
  STAGING_PORT_PROBE,
  STAGING_RUNTIME_INVENTORY,
  type StagingContextCollectRequest,
  type StagingContextCollectionResult,
  type StagingContextCollector,
  type StagingContextSnapshot,
  type StagingDryRunIssue,
  type StagingHostMetricsReader,
  type StagingHostMetricsSnapshot,
  type StagingPortProbe,
  type StagingRuntimeInventory,
  type StagingRuntimeInventorySnapshot,
} from "../domain/staging-context";
import type { StagingDatabaseTarget } from "../domain/staging-planner";

const DOCKER_LIST_TIMEOUT_MS = 10_000;
const DISK_CHECK_TIMEOUT_MS = 5_000;

/**
 * ADAPTADOR READ-ONLY DO CONTEXTO DE STAGING (P1A).
 *
 * Fontes:
 *  - Core DB: projeto, bancos gerenciados e variáveis cifradas (já decifradas
 *    pelo repositório);
 *  - `docker ps -a` somente leitura para inventário de portas e ambientes
 *    efêmeros;
 *  - métricas do host (memória/cpu) e `df -k /` para disco.
 *
 * Nenhum comando Docker de escrita é emitido aqui.
 */
@Injectable()
export class ReadOnlyStagingContextCollector implements StagingContextCollector {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly databaseRepository: ManagedDatabaseRepository,
    @Inject(ENV_VAR_REPOSITORY) private readonly envVarRepository: EnvVarRepository,
    @Optional()
    @Inject(STAGING_RUNTIME_INVENTORY)
    runtimeInventory: StagingRuntimeInventory | null = null,
    @Optional()
    @Inject(STAGING_HOST_METRICS)
    hostMetrics: StagingHostMetricsReader | null = null,
    @Optional()
    @Inject(STAGING_PORT_PROBE)
    portProbe: StagingPortProbe | null = null,
  ) {
    this.runtimeInventory = runtimeInventory ?? new DockerStagingRuntimeInventory();
    this.hostMetrics = hostMetrics ?? new LocalStagingHostMetrics();
    this.portProbe = portProbe ?? new LocalStagingPortProbe();
  }

  private readonly runtimeInventory: StagingRuntimeInventory;
  private readonly hostMetrics: StagingHostMetricsReader;
  private readonly portProbe: StagingPortProbe;

  async collect(request: StagingContextCollectRequest): Promise<StagingContextCollectionResult> {
    const issues: StagingDryRunIssue[] = [];

    let project;
    let projects;
    let databases;
    let envVars;
    try {
      project = await this.projectRepository.findById(request.projectId);
      if (!project) {
        return fail(
          "STAGING_PROJECT_NOT_FOUND",
          "projectId",
          `Projeto ${request.projectId} não encontrado.`,
        );
      }
      projects = await this.projectRepository.findAll();
      databases = await this.databaseRepository.findAllByProjectId(request.projectId);
      envVars = await this.envVarRepository.findByProjectId(request.projectId);
    } catch {
      return fail(
        "STAGING_CONTEXT_UNAVAILABLE",
        "project",
        "Não foi possível ler os metadados do projeto; dry-run recusado.",
      );
    }

    let runtime: StagingRuntimeInventorySnapshot;
    try {
      runtime = await this.runtimeInventory.inspect();
    } catch {
      return fail(
        "STAGING_CONTEXT_UNAVAILABLE",
        "docker",
        "Docker indisponível para leitura; dry-run recusado sem fallback.",
      );
    }

    let hostMetrics: StagingHostMetricsSnapshot;
    try {
      hostMetrics = await this.hostMetrics.read();
    } catch {
      return fail(
        "STAGING_CONTEXT_UNAVAILABLE",
        "host",
        "Não foi possível ler os recursos do host; dry-run recusado.",
      );
    }

    let probedUnavailablePorts: number[];
    try {
      probedUnavailablePorts = await this.portProbe.findUnavailable(
        Array.isArray(request.portCandidates) ? request.portCandidates : [],
      );
    } catch {
      return fail(
        "STAGING_CONTEXT_UNAVAILABLE",
        "ports",
        "Não foi possível verificar as portas candidatas; dry-run recusado.",
      );
    }

    if (!isPositiveNumber(hostMetrics.availableCpu)) {
      issues.push({
        code: "STAGING_CONTEXT_INCOMPLETE",
        field: "host.availableCpu",
        message: "CPU disponível não pôde ser determinada.",
      });
    }
    if (!isNonNegativeNumber(hostMetrics.availableMemoryMb)) {
      issues.push({
        code: "STAGING_CONTEXT_INCOMPLETE",
        field: "host.availableMemoryMb",
        message: "Memória disponível não pôde ser determinada.",
      });
    }
    if (!isNonNegativeNumber(hostMetrics.freeDiskMb)) {
      issues.push({
        code: "STAGING_CONTEXT_INCOMPLETE",
        field: "host.freeDiskMb",
        message: "Disco livre não pôde ser determinado.",
      });
    }
    if (!isNonNegativeInteger(runtime.activeStagingEnvironments)) {
      issues.push({
        code: "STAGING_CONTEXT_INCOMPLETE",
        field: "docker.activeStagingEnvironments",
        message: "Inventário de ambientes de staging não pôde ser lido.",
      });
    }

    if (issues.length > 0) {
      return { ok: false, snapshot: null, issues };
    }

    const production = {
      volumes: collectProductionVolumes(databases),
      networks: collectProductionNetworks(project.containerName),
      databaseTargets: collectDatabaseTargets(databases, envVars),
      secretFingerprints: collectSecretFingerprints(databases, envVars),
      hostPorts: projects
        .map((entry) => entry.assignedPort)
        .filter((port): port is number => typeof port === "number" && Number.isInteger(port) && port > 0),
    };

    const snapshot: StagingContextSnapshot = {
      production,
      host: {
        availableCpu: hostMetrics.availableCpu as number,
        availableMemoryMb: hostMetrics.availableMemoryMb as number,
        freeDiskMb: hostMetrics.freeDiskMb as number,
        activeEnvironments: runtime.activeStagingEnvironments,
        maxConcurrentEnvironments: request.maxConcurrentEnvironments,
        maxTtlMinutes: request.maxTtlMinutes,
        portCandidates: Array.isArray(request.portCandidates) ? [...request.portCandidates] : [],
        unavailablePorts: [
          ...new Set([...runtime.unavailablePorts, ...probedUnavailablePorts]),
        ],
      },
      warnings: [
        "Fingerprints detectam reutilização exata de segredo; não provam ausência de acesso à produção.",
        "Volumes e redes de produção são derivados dos metadados conhecidos do projeto; o Docker é consultado somente para portas/ambientes efêmeros.",
        "O dry-run não reserva porta nem inicia qualquer recurso.",
      ],
    };

    return { ok: true, snapshot, issues: [] };
  }
}

/** Implementação read-only do inventário Docker. Lista, nunca cria/remove. */
@Injectable()
export class DockerStagingRuntimeInventory implements StagingRuntimeInventory {
  async inspect(): Promise<StagingRuntimeInventorySnapshot> {
    const result = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--format",
        '{{.State}}\t{{.Label "korrelo.ephemeral"}}\t{{.Ports}}',
      ],
      { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error("Docker indisponível para leitura.");
    }

    let activeStagingEnvironments = 0;
    const unavailablePorts = new Set<number>();
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [state, ephemeral, ports] = line.split("\t");
      if (state === "running" && ephemeral === "true") activeStagingEnvironments += 1;
      for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0) unavailablePorts.add(port);
      }
    }

    return {
      activeStagingEnvironments,
      unavailablePorts: [...unavailablePorts],
    };
  }
}

/** Métricas do host. `df` é somente leitura; Docker não é usado aqui. */
@Injectable()
export class LocalStagingHostMetrics implements StagingHostMetricsReader {
  async read(): Promise<StagingHostMetricsSnapshot> {
    const resources = await readHostResources({ provider: realHostResourceProvider });
    const availableCpu =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus()?.length ?? null;
    return {
      availableCpu,
      availableMemoryMb: resources.memAvailableMb,
      freeDiskMb: await readDiskFreeMb(),
    };
  }
}

/**
 * Sonda de porta SOMENTE LEITURA: faz connect em 127.0.0.1 para saber se algo
 * já responde. Não faz bind, listen nem publica porta.
 */
@Injectable()
export class LocalStagingPortProbe implements StagingPortProbe {
  async findUnavailable(ports: number[]): Promise<number[]> {
    const unavailable: number[] = [];
    for (const port of ports) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
      if (await isPortReachable(port)) unavailable.push(port);
    }
    return unavailable;
  }
}

function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function readDiskFreeMb(): Promise<number | null> {
  try {
    const result = await runCommand("df", ["-k", "/"], { timeoutMs: DISK_CHECK_TIMEOUT_MS });
    if (result.timedOut || result.exitCode !== 0) return null;
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    const parts = lastLine.split(/\s+/);
    const availableKb = Number(parts[3]);
    if (!Number.isFinite(availableKb) || availableKb <= 0) return null;
    return Math.round(availableKb / 1024);
  } catch {
    return null;
  }
}

function collectProductionVolumes(databases: ManagedDatabase[]): string[] {
  const volumes = new Set<string>(["uploads-data"]);
  for (const database of databases) {
    if (database.type !== "custom" && database.serviceName) {
      volumes.add(`${database.serviceName}-data`);
    }
  }
  return [...volumes];
}

function collectProductionNetworks(containerName: string | null): string[] {
  const networks = new Set<string>(["korrelo-shared"]);
  if (containerName) networks.add(`${containerName}_default`);
  return [...networks];
}

function collectDatabaseTargets(
  databases: ManagedDatabase[],
  envVars: EnvVar[],
): StagingDatabaseTarget[] {
  const targets = new Map<string, StagingDatabaseTarget>();
  const add = (target: StagingDatabaseTarget | null) => {
    if (!target) return;
    const key = targetKey(target);
    if (key) targets.set(key, target);
  };

  for (const database of databases) {
    add(targetForDatabase(database));
  }
  for (const envVar of envVars) {
    if (!DATABASE_KEY_PATTERN.test(envVar.key)) continue;
    add(parseDatabaseTarget(envVar.value));
  }
  return [...targets.values()];
}

function collectSecretFingerprints(
  databases: ManagedDatabase[],
  envVars: EnvVar[],
): string[] {
  const fingerprints = new Set<string>();
  for (const database of databases) {
    if (database.password) fingerprints.add(hashSecret(database.password));
    if (database.connectionString) fingerprints.add(hashSecret(database.connectionString));
  }
  for (const envVar of envVars) {
    if (SENSITIVE_KEY_PATTERN.test(envVar.key)) {
      fingerprints.add(hashSecret(envVar.value));
    }
  }
  return [...fingerprints].filter(Boolean);
}

function targetForDatabase(database: ManagedDatabase): StagingDatabaseTarget | null {
  if (database.type === "custom") return parseDatabaseTarget(database.connectionString);
  if (!database.serviceName) return null;
  if (database.type === "postgres") {
    return {
      scheme: "postgresql",
      host: database.serviceName,
      port: 5432,
      database: database.databaseName,
    };
  }
  if (database.type === "mongodb") {
    return {
      scheme: "mongodb",
      host: database.serviceName,
      port: 27017,
      database: database.databaseName,
    };
  }
  if (database.type === "redis") {
    return { scheme: "redis", host: database.serviceName, port: 6379, database: null };
  }
  return null;
}

function parseDatabaseTarget(value: string | null | undefined): StagingDatabaseTarget | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    const normalizedScheme =
      scheme === "postgres" ? "postgresql" : scheme === "mongo" ? "mongodb" : scheme;
    const defaultPort =
      normalizedScheme === "postgresql"
        ? 5432
        : normalizedScheme === "mongodb"
          ? 27017
          : normalizedScheme === "mysql"
            ? 3306
            : normalizedScheme === "redis"
              ? 6379
              : null;
    if (!defaultPort || !url.hostname) return null;
    const port = url.port ? Number(url.port) : defaultPort;
    if (!Number.isInteger(port) || port <= 0) return null;
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, "")) || null;
    return { scheme: normalizedScheme, host: url.hostname, port, database };
  } catch {
    return null;
  }
}

function targetKey(target: StagingDatabaseTarget): string {
  return `${target.scheme.trim().toLowerCase()}://${target.host.trim().toLowerCase()}:${target.port}/${target.scheme === "redis" ? "" : target.database ?? ""}`;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function fail(code: string, field: string, message: string): StagingContextCollectionResult {
  return { ok: false, snapshot: null, issues: [{ code, field, message }] };
}

const SENSITIVE_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|API[_-]?KEY|DATABASE_URL|MONGO|REDIS|MYSQL|POSTGRES|CONNECTION)/i;
const DATABASE_KEY_PATTERN = /(DATABASE_URL|MONGO|REDIS|MYSQL|POSTGRES|PG_|CONNECTION)/i;
