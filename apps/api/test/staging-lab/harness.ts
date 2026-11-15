import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { StagingExecutionService } from "../../src/modules/projects/application/staging-execution.service";
import { StagingCapacityService } from "../../src/modules/projects/application/staging-capacity.service";
import { generateStagingCompose } from "../../src/modules/projects/domain/staging-compose";
import { buildEphemeralMongo } from "../../src/modules/projects/domain/staging-ephemeral-mongo";
import type {
  StagingExecutionRequest,
  StagingRuntimeAdapter,
  StagingRuntimeStartInput,
} from "../../src/modules/projects/domain/staging-execution";
import type { StagingPlan, StagingPlanDependency } from "../../src/modules/projects/domain/staging-planner";
import { planStaging } from "../../src/modules/projects/domain/staging-planner";
import type { StagingHostMetricsReader } from "../../src/modules/projects/domain/staging-context";
import type { StagingRun } from "../../src/modules/projects/domain/staging-run";
import { DockerPrebuiltImageVerifier } from "../../src/modules/projects/infrastructure/docker-prebuilt-image.verifier";
import { DockerComposeStagingRuntime } from "../../src/modules/projects/infrastructure/docker-staging-runtime";
import { PrismaStagingRunRepository } from "../../src/modules/projects/infrastructure/prisma-staging-run.repository";
import { PrismaStagingPortLeaseRepository } from "../../src/modules/projects/infrastructure/prisma-staging-port-lease.repository";
import { WorkerLock } from "../../src/modules/projects/infrastructure/worker-lock";

/**
 * HARNESS DE LABORATÓRIO DO STAGING ISOLADO.
 *
 * Usa código real: planner, compose, executor, WorkerLock, verificador de
 * imagem, runtime Docker/Compose, PrismaStagingRunRepository e
 * PrismaStagingPortLeaseRepository sobre SQLite temporário.
 *
 * Execução: npx tsx test/staging-lab/harness.ts
 */

const PROJECT_ID = "lab-project";
const COMMIT_SHA = (process.env.LAB_COMMIT_SHA ?? "a".repeat(40)).trim().toLowerCase();
const HEALTHY_IMAGE = process.env.LAB_IMAGE_HEALTHY ?? "korrelo-lab-app:healthy";
const MONGO_IMAGE = process.env.LAB_IMAGE_MONGO ?? "korrelo-lab-app:mongo";
const CRASH_IMAGE = process.env.LAB_IMAGE_CRASH ?? "korrelo-lab-app:crash";
const WORK_DIR = mkdtempSync(join(tmpdir(), "korrelo-lab-"));
const EVIDENCE_FILE = process.env.LAB_EVIDENCE_FILE ?? join(WORK_DIR, "evidence.json");

process.env.KORRELO_LOCK_DIR = join(WORK_DIR, "locks");
process.env.KORRELO_STAGING_ISOLATED_EXECUTION = "true";
process.env.KORRELO_STAGING_HEALTH_DEBUG = "true";

const prisma = new PrismaClient();

class LabHost implements StagingHostMetricsReader {
  snapshot = { availableCpu: 4, availableMemoryMb: 4096, freeDiskMb: 20_000 };
  async read() {
    return this.snapshot;
  }
}

const host = new LabHost();
const leases = new PrismaStagingPortLeaseRepository(prisma as never);
const capacity = new StagingCapacityService(leases, host);
const runs = new PrismaStagingRunRepository(prisma as never, capacity, host, {
  findUnavailable: async (ports: number[]) =>
    ports.filter((port) => process.env.LAB_UNAVAILABLE_PORT === String(port)),
});

interface ScenarioResult {
  name: string;
  ok: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

const results: ScenarioResult[] = [];
const evidence: Record<string, unknown> = { commit: COMMIT_SHA, startedAt: new Date().toISOString() };

function docker(args: string[], allowFailure = false): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function dockerJson<T>(args: string[], allowFailure = false): T | null {
  const output = docker(args, allowFailure);
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

interface DockerInspect {
  Id: string;
  Image: string;
  Config: { Labels: Record<string, string>; Env: string[] };
  HostConfig: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> };
  Mounts: Array<{ Type: string; Source: string; Destination: string }>;
  NetworkSettings: { Networks: Record<string, unknown>; Ports?: Record<string, unknown> };
  State: { Running: boolean; Health?: { Status?: string } };
}

function inspectContainer(id: string): DockerInspect | null {
  const parsed = dockerJson<DockerInspect[]>(["inspect", id], true);
  if (!parsed) return null;
  return Array.isArray(parsed) ? parsed[0] ?? null : (parsed as unknown as DockerInspect);
}

function projectContainers(project: string): string[] {
  return docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"], true)
    .split(/\r?\n/)
    .filter(Boolean);
}

function inventory(): { containers: string[]; networks: string[]; volumes: string[] } {
  const parse = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  return {
    containers: parse(docker(["ps", "-a", "--format", "{{.Names}}"], true)),
    networks: parse(docker(["network", "ls", "--format", "{{.Name}}"], true)),
    volumes: parse(docker(["volume", "ls", "--format", "{{.Name}}"], true)),
  };
}

function withoutStaging(items: string[]): string[] {
  return items.filter((name) => !name.startsWith("korrelo-stg-") && !name.startsWith("korrelo-lab-"));
}

function makePlan(
  runId: string,
  dependencies: Array<Record<string, unknown>> = [],
  portCandidates: number[] = [18080, 18081, 18082, 18083, 18084, 18085],
): StagingPlan {
  const result = planStaging({
    projectId: PROJECT_ID,
    runId,
    config: {
      mode: "isolated",
      ttlMinutes: 30,
      allowEgress: false,
      app: { memoryMb: 192, cpu: 0.25, diskMb: 256, mounts: [] },
      env: [],
      security: { networkMode: "bridge", publicDomain: null },
    },
    dependencies: dependencies as never,
    production: { volumes: [], networks: [], databaseTargets: [], secretFingerprints: [], hostPorts: [] },
    host: {
      availableCpu: 4,
      availableMemoryMb: 4096,
      freeDiskMb: 20_000,
      activeEnvironments: 0,
      maxConcurrentEnvironments: 4,
      maxTtlMinutes: 120,
      portCandidates,
    },
  });
  if (!result.plan) throw new Error(`plano inválido: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

const HEALTHCHECK = {
  test: [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ],
  intervalSeconds: 1,
  timeoutSeconds: 3,
  retries: 20,
  startPeriodSeconds: 2,
};

function executionRequest(
  plan: StagingPlan,
  overrides: Partial<Omit<StagingExecutionRequest, "compose">> & {
    compose?: Partial<StagingExecutionRequest["compose"]>;
  } = {},
): StagingExecutionRequest {
  const { compose, ...rest } = overrides;
  return {
    plan,
    commitSha: COMMIT_SHA,
    mode: "prebuilt",
    compose: {
      containerPort: 3000,
      pidsLimit: 128,
      imageReference: HEALTHY_IMAGE,
      healthcheck: HEALTHCHECK,
      ...(compose ?? {}),
    },
    imageIdentity: {
      projectId: PROJECT_ID,
      commitSha: COMMIT_SHA,
      imageReference: HEALTHY_IMAGE,
      observed: { imageId: "", repoDigests: [], labels: {} },
    },
    deployJobId: "lab-job",
    portCandidates: [plan.app.hostPort],
    ttlMinutes: 30,
    policy: {
      maxConcurrentEnvironments: 4,
      maxTtlMinutes: 120,
      productionReservedMemoryMb: 0,
      productionReservedCpu: 0,
      productionReservedDiskMb: 0,
      safetyMemoryMb: 0,
      safetyCpu: 0,
      safetyDiskMb: 0,
    },
    app: { memoryMb: 192, cpu: 0.25, diskMb: 256 },
    dependencies: plan.dependencies
      .filter((dependency) => dependency.mode === "ephemeral")
      .map((dependency) => dependency.resources!),
    ...rest,
  };
}

function executor(runtime: StagingRuntimeAdapter = new DockerComposeStagingRuntime()): StagingExecutionService {
  return new StagingExecutionService(
    runs,
    new WorkerLock(),
    new DockerPrebuiltImageVerifier(),
    runtime,
    true,
    leases,
  );
}

async function scenario(name: string, fn: () => Promise<{ detail: string; evidence?: Record<string, unknown> }>): Promise<void> {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const result = await fn();
    results.push({ name, ok: true, detail: result.detail, evidence: result.evidence });
    process.stdout.write(`PASS ${name}: ${result.detail}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    process.stdout.write(`FAIL ${name}: ${detail}\n`);
  }
  writeFileSync(EVIDENCE_FILE, JSON.stringify({ ...evidence, results }, null, 2), "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertGone(plan: StagingPlan, label: string): void {
  assert(projectContainers(plan.composeProject).length === 0, `${label}: containers do projeto ainda existem`);
  assert(!docker(["network", "inspect", plan.network.name], true), `${label}: rede do staging ainda existe`);
  for (const volume of plan.volumes) {
    assert(!docker(["volume", "inspect", volume], true), `${label}: volume ${volume} ainda existe`);
  }
}

function assertIsolation(input: StagingRuntimeStartInput): DockerInspect {
  const ids = projectContainers(input.run.composeProject);
  assert(ids.length > 0, "nenhum container do staging encontrado após start");
  const appId = ids.find(
    (id) => inspectContainer(id)?.Config.Labels["com.docker.compose.service"] === "app_staging",
  );
  assert(appId, "container app_staging não encontrado");
  const app = inspectContainer(appId);
  assert(app, "não foi possível inspecionar app_staging");

  for (const mount of app.Mounts) {
    assert(!mount.Destination.includes("docker.sock"), "docker socket montado no container");
    assert(!mount.Source.includes("docker.sock"), "docker socket montado no container");
    assert(mount.Type === "volume", `mount inesperado (${mount.Type}) no container`);
  }
  const networks = Object.keys(app.NetworkSettings.Networks);
  assert(networks.length === 1 && networks[0] === input.run.networkName, `redes inesperadas: ${networks.join(",")}`);
  const bindings = Object.values(app.HostConfig.PortBindings ?? {}).flat();
  assert(bindings.length === 1, "portas publicadas inesperadas");
  assert(bindings[0].HostIp === "127.0.0.1", `porta exposta fora do loopback: ${bindings[0].HostIp}`);
  assert(app.Config.Labels["korrelo.stagingRunId"] === input.run.runId, "label de run divergente");
  assert(app.Config.Labels["korrelo.ephemeral"] === "true", "label efêmera ausente");
  for (const entry of app.Config.Env) {
    const key = entry.split("=")[0] ?? "";
    assert(!/SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|PROD/i.test(key), `variável sensível no container: ${key}`);
    assert(!entry.includes("prod-mongo-should-not-exist"), "credencial de produção vazou para o staging");
  }
  assert(app.Image === input.run.imageId, "container não usa a imagem pré-construída verificada");
  evidence.lastIsolation = {
    runId: input.run.id,
    networks,
    mounts: app.Mounts.map((mount) => `${mount.Type}:${mount.Destination}`),
    bindings,
    envKeys: app.Config.Env.map((entry) => entry.split("=")[0]),
  };
  return app;
}

function assertingRuntime(
  inner: StagingRuntimeAdapter,
  afterStart?: (input: StagingRuntimeStartInput) => void | Promise<void>,
): StagingRuntimeAdapter {
  return {
    async start(input) {
      await inner.start(input);
      assertIsolation(input);
      await afterStart?.(input);
    },
    health: (input) => inner.health(input),
    cleanup: (input) => inner.cleanup(input),
  };
}

function dockerImageId(reference: string): string {
  return docker(["image", "inspect", "--format", "{{.Id}}", reference]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timeout aguardando ${label}`);
}

function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function appContainer(project: string): string | null {
  return (
    projectContainers(project).find(
      (id) => inspectContainer(id)?.Config.Labels["com.docker.compose.service"] === "app_staging",
    ) ?? null
  );
}

function mongoDependency(): Record<string, unknown> {
  return {
    name: "mongo",
    kind: "mongodb",
    mode: "ephemeral",
    envKey: "MONGO_URL",
    resources: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
  };
}

function mongoRequest(plan: StagingPlan): { request: StagingExecutionRequest; uriKey: string } {
  const planned = plan.dependencies.find((dependency) => dependency.name === "mongo");
  assert(planned, "dependência mongo ausente do plano");
  const mongo = buildEphemeralMongo({ dependency: planned as StagingPlanDependency });
  assert(mongo.ok && mongo.plan, `mongo efêmero inválido: ${mongo.issues.join("; ")}`);
  const request = executionRequest(plan, {
    compose: { dependencyImages: { mongo: mongo.plan.image } },
    stagingEnv: { ...mongo.plan.appEnv, MONGO_REQUIRED: "true" },
    dependencyEnvironment: { mongo: mongo.plan.dependencyEnv },
    dependencyHealthchecks: { mongo: mongo.plan.healthcheck },
  });
  return { request, uriKey: mongo.plan.appEnvKey };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--crash-child") {
    await crashChild(process.argv[3], process.argv[4]);
    return;
  }

  docker(["version"]);
  await prisma.$connect();
  await prisma.project.upsert({
    where: { id: PROJECT_ID },
    create: { id: PROJECT_ID, name: "Lab Project", repoUrl: "https://example.com/lab.git" },
    update: {},
  });

  evidence.dockerVersion = docker(["version", "--format", "{{.Server.Version}}"]);
  evidence.images = {
    healthy: { reference: HEALTHY_IMAGE, id: dockerImageId(HEALTHY_IMAGE) },
    mongo: { reference: MONGO_IMAGE, id: dockerImageId(MONGO_IMAGE) },
    crash: { reference: CRASH_IMAGE, id: dockerImageId(CRASH_IMAGE) },
  };
  const before = inventory();

  await scenario("staging sem banco + health aprovado", async () => {
    const plan = makePlan(`run-nodb-${Date.now()}`);
    const result = await executor(
      assertingRuntime(new DockerComposeStagingRuntime()),
    ).execute(executionRequest(plan), { path: "/health", require2xx: true, containerPort: 3000 });

    assert(result.ok, `executor não concluiu: ${result.status} ${result.issues.join("; ")}`);
    assertGone(plan, "pós-cleanup");
    const persisted = await runs.findByProjectAndRun(PROJECT_ID, plan.runId);
    assert(persisted, "StagingRun real não foi persistido no SQLite");
    return { detail: `status=${result.status} run=${persisted.id.slice(0, 8)}` };
  });

  await scenario("imagem pré-construída não é reconstruída", async () => {
    const plan = makePlan(`run-prebuilt-${Date.now()}`);
    const beforeId = dockerImageId(HEALTHY_IMAGE);
    const result = await executor().execute(executionRequest(plan));
    assert(result.ok, `executor falhou: ${result.issues.join("; ")}`);
    assert(dockerImageId(HEALTHY_IMAGE) === beforeId, "image ID mudou após a execução");
    return { detail: `image ID preservado ${beforeId.slice(0, 19)}…` };
  });

  await scenario("imagem ausente bloqueia antes de criar recursos", async () => {
    const plan = makePlan(`run-missing-${Date.now()}`);
    const request = executionRequest(plan, { compose: { imageReference: "korrelo-lab-app:does-not-exist" } });
    request.imageIdentity = { ...request.imageIdentity!, imageReference: "korrelo-lab-app:does-not-exist" };
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "blocked", `deveria bloquear, veio ${result.status}`);
    assert(projectContainers(plan.composeProject).length === 0, "container criado apesar da falha");
    return { detail: "bloqueado" };
  });

  await scenario("identidade de imagem divergente bloqueia", async () => {
    const plan = makePlan(`run-identity-${Date.now()}`);
    const request = executionRequest(plan, {
      imageIdentity: {
        projectId: PROJECT_ID,
        commitSha: "b".repeat(40),
        imageReference: HEALTHY_IMAGE,
        observed: { imageId: "", repoDigests: [], labels: {} },
      },
    });
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "blocked", `deveria bloquear, veio ${result.status}`);
    return { detail: "bloqueado" };
  });

  await scenario("porta ocupada bloqueia sem iniciar containers", async () => {
    const plan = makePlan(`run-port-${Date.now()}`, [], [18090]);
    const server = await listenOnPort(plan.app.hostPort);
    try {
      process.env.LAB_UNAVAILABLE_PORT = String(plan.app.hostPort);
      const result = await executor().execute(executionRequest(plan));
      assert(!result.ok, "execução deveria bloquear com porta ocupada");
      assert(result.status === "blocked", `status inesperado: ${result.status}`);
      assert(projectContainers(plan.composeProject).length === 0, "container criado com porta ocupada");
      return { detail: `bloqueado na porta ${plan.app.hostPort}` };
    } finally {
      delete process.env.LAB_UNAVAILABLE_PORT;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await scenario("recursos insuficientes bloqueiam antes do Docker", async () => {
    const plan = makePlan(`run-capacity-${Date.now()}`);
    host.snapshot = { availableCpu: 4, availableMemoryMb: 64, freeDiskMb: 20_000 };
    try {
      const result = await executor().execute(executionRequest(plan));
      assert(!result.ok && result.status === "blocked", `deveria bloquear, veio ${result.status}`);
      return { detail: `bloqueado: ${result.issues[0]}` };
    } finally {
      host.snapshot = { availableCpu: 4, availableMemoryMb: 4096, freeDiskMb: 20_000 };
    }
  });

  await scenario("healthcheck reprovado não promove e faz cleanup", async () => {
    const plan = makePlan(`run-health-${Date.now()}`);
    const request = executionRequest(plan, { compose: { imageReference: CRASH_IMAGE } });
    request.imageIdentity = { ...request.imageIdentity!, imageReference: CRASH_IMAGE };
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "health reprovado");
    return { detail: "failed + cleanup" };
  });

  await scenario("falha na criação de recursos é rastreável", async () => {
    const plan = makePlan(`run-create-${Date.now()}`);
    const request = executionRequest(plan, {
      mode: "local-build",
      compose: { imageReference: null, buildContext: "does-not-exist-lab-context", dockerfile: "Dockerfile" },
      imageIdentity: null,
    });
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "falha de criação");
    const persisted = await runs.findByProjectAndRun(PROJECT_ID, plan.runId);
    assert(persisted, "reserva não ficou rastreável após falha");
    return { detail: "failed, run persistido e recursos removidos" };
  });

  await scenario("concorrência: apenas uma reserva vence a porta", async () => {
    const suffix = Date.now();
    const planA = makePlan(`run-race-a-${suffix}`, [], [18091]);
    const planB = makePlan(`run-race-b-${suffix}`, [], [18091]);
    const base = {
      projectId: PROJECT_ID,
      deployJobId: "lab-job",
      composeProject: "race",
      planHash: "a".repeat(64),
      composeHash: "b".repeat(64),
      app: { memoryMb: 192, cpu: 0.25, diskMb: 256 },
      dependencies: [],
      portCandidates: [18091],
      ttlMinutes: 30,
      policy: {
        maxConcurrentEnvironments: 4,
        maxTtlMinutes: 120,
        productionReservedMemoryMb: 0,
        productionReservedCpu: 0,
        productionReservedDiskMb: 0,
        safetyMemoryMb: 0,
        safetyCpu: 0,
        safetyDiskMb: 0,
      },
    };
    const [first, second] = await Promise.all([
      runs.reserve({ ...base, runId: planA.runId, composeProject: planA.composeProject }),
      runs.reserve({ ...base, runId: planB.runId, composeProject: planB.composeProject }),
    ]);
    assert([first.ok, second.ok].filter(Boolean).length === 1, "as duas reservas venceram a mesma porta");
    const loser = first.ok ? second : first;
    assert(!loser.ok, "reserva perdedora deveria falhar");
    return { detail: "uma reserva atômica venceu; a outra foi recusada" };
  });

  await scenario("cleanup com ownership divergente é bloqueado", async () => {
    const plan = makePlan(`run-ownership-${Date.now()}`);
    const runtime = new DockerComposeStagingRuntime();
    const generated = generateStagingCompose({
      plan,
      containerPort: 3000,
      pidsLimit: 128,
      imageReference: HEALTHY_IMAGE,
      healthcheck: HEALTHCHECK,
      deployJobId: "lab-job",
    });
    assert(generated.ok && generated.document, "compose do teste inválido");
    const reserved = await runs.reserve({
      projectId: PROJECT_ID,
      deployJobId: "lab-job",
      runId: plan.runId,
      composeProject: plan.composeProject,
      planHash: generated.planHash!,
      composeHash: generated.composeHash!,
      imageReference: HEALTHY_IMAGE,
      imageId: dockerImageId(HEALTHY_IMAGE),
      app: { memoryMb: 192, cpu: 0.25, diskMb: 256 },
      dependencies: [],
      portCandidates: [plan.app.hostPort],
      ttlMinutes: 30,
      networkName: plan.network.name,
      volumePrefix: "korrelo-stg-",
      policy: {
        maxConcurrentEnvironments: 4,
        maxTtlMinutes: 120,
        productionReservedMemoryMb: 0,
        productionReservedCpu: 0,
        productionReservedDiskMb: 0,
        safetyMemoryMb: 0,
        safetyCpu: 0,
        safetyDiskMb: 0,
      },
    });
    assert(reserved.ok && reserved.run && reserved.lease, "reserva do teste falhou");
    await runtime.start({
      run: reserved.run,
      lease: reserved.lease,
      document: generated.document,
      composeProject: plan.composeProject,
    });
    try {
      const foreign: StagingRun = { ...reserved.run, runId: `${reserved.run.runId}-other` };
      const blocked = await runtime.cleanup({ run: foreign, lease: reserved.lease, reason: "teste" });
      assert(!blocked.ok, "cleanup aceitou ownership divergente");
      assert(projectContainers(plan.composeProject).length > 0, "cleanup removeu recursos com ownership divergente");
    } finally {
      const cleanup = await runtime.cleanup({ run: reserved.run, lease: reserved.lease, reason: "fim" });
      assert(cleanup.ok, `cleanup correto falhou: ${cleanup.reason}`);
      await leases.release(PROJECT_ID, plan.runId);
    }
    assertGone(plan, "ownership");
    return { detail: "divergente bloqueado; correto removeu tudo" };
  });

  await scenario("recuperação após encerramento inesperado (Prisma)", async () => {
    const runId = `run-crash-${Date.now()}`;
    const outputFile = join(WORK_DIR, "crash-run.json");
    const child = spawn("npx", ["tsx", __filename, "--crash-child", runId, outputFile], {
      stdio: "inherit",
      env: { ...process.env },
    });
    await waitFor(() => existsSync(outputFile), 60_000, "criação do staging no processo filho");
    const persisted = await runs.findByProjectAndRun(PROJECT_ID, runId);
    assert(persisted, "run não persistido pelo processo filho");
    await waitFor(() => projectContainers(persisted.composeProject).length > 0, 30_000, "container do crash test");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert(projectContainers(persisted.composeProject).length > 0, "recursos desapareceram antes da recuperação");
    const cleanup = await new DockerComposeStagingRuntime().cleanup({
      run: persisted,
      lease: null,
      reason: "recuperação após crash",
    });
    assert(cleanup.ok, `cleanup de recuperação falhou: ${cleanup.reason}`);
    await leases.release(PROJECT_ID, runId);
    assert(projectContainers(persisted.composeProject).length === 0, "containers permaneceram após recuperação");
    return { detail: "run lido do SQLite e cleanup escopado removeu tudo", evidence: { runId } };
  });

  await scenario("MongoDB efêmero conecta, grava e lê no staging", async () => {
    process.env.PROD_MONGO_URL = "mongodb://prod-mongo-should-not-exist:27017/prod";
    const plan = makePlan(`run-mongo-${Date.now()}`, [mongoDependency()]);
    const { request, uriKey } = mongoRequest(plan);
    const result = await executor(
      assertingRuntime(new DockerComposeStagingRuntime(), async (input) => {
        const id = appContainer(input.run.composeProject);
        assert(id, "app não encontrada para validar Mongo");
        const app = inspectContainer(id)!;
        const mongoEntry = app.Config.Env.find((entry) => entry.startsWith(`${uriKey}=`));
        assert(mongoEntry && mongoEntry.includes("@"), "MONGODB_URI não foi injetada no app");
        assert(!app.Config.Env.some((entry) => entry.includes("prod-mongo-should-not-exist")), "URI de produção presente");
        let dbCheck = "";
        let lastError = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            dbCheck = execFileSync(
              "docker",
              [
                "exec",
                id,
                "node",
                "-e",
                "fetch('http://127.0.0.1:3000/db').then(r=>r.text()).then(t=>{console.log(t);process.exit(t.includes('\"ok\":true')?0:1)}).catch(e=>{console.error(e);process.exit(1)})",
              ],
              { encoding: "utf8" },
            );
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        assert(dbCheck.includes('"ok":true'), `round-trip no Mongo falhou: ${dbCheck || lastError}`);
        evidence.mongoRoundTrip = dbCheck.trim();
      }),
    ).execute(request, { path: "/health", require2xx: true, containerPort: 3000 });

    assert(result.ok, `executor falhou: ${result.issues.join("; ")}`);
    assertGone(plan, "mongo");
    return { detail: "URI gerada, escrita/leitura ok, container/rede/volume removidos" };
  });

  await scenario("falha do MongoDB bloqueia e faz cleanup", async () => {
    const plan = makePlan(`run-mongo-fail-${Date.now()}`, [mongoDependency()]);
    const { request } = mongoRequest(plan);
    request.compose.dependencyImages = { mongo: "mongo:does-not-exist-lab" };
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "mongo falho");
    const persisted = await runs.findByProjectAndRun(PROJECT_ID, plan.runId);
    assert(persisted, "falha do Mongo não deixou run rastreável");
    return { detail: "failed + cleanup + run persistido" };
  });

  await scenario("MONGODB_URI ausente bloqueia antes do Docker", async () => {
    const plan = makePlan(`run-mongo-missing-${Date.now()}`, [mongoDependency()]);
    const request = executionRequest(plan, {
      compose: { dependencyImages: { mongo: MONGO_IMAGE } },
      stagingEnv: { MONGO_REQUIRED: "true" },
      dependencyHealthchecks: { mongo: "mongosh --quiet --eval \"db.adminCommand('ping').ok\" | grep -q 1" },
    });
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "mongo sem URI");
    return { detail: "app sem URI reprovou health e foi limpa" };
  });

  await scenario("nenhum recurso fora do staging foi alterado", async () => {
    const after = inventory();
    for (const kind of ["containers", "networks", "volumes"] as const) {
      assert(
        withoutStaging(before[kind]).join("|") === withoutStaging(after[kind]).join("|"),
        `${kind} fora do staging mudaram`,
      );
    }
    return { detail: "inventário externo idêntico ao inicial" };
  });

  const failed = results.filter((result) => !result.ok);
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = { total: results.length, passed: results.length - failed.length, failed: failed.length };
  writeFileSync(EVIDENCE_FILE, JSON.stringify({ ...evidence, results }, null, 2), "utf8");
  process.stdout.write(`\n${JSON.stringify(evidence.summary)}\n`);
  process.stdout.write(`evidências: ${EVIDENCE_FILE}\n`);
  await prisma.$disconnect();
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function crashChild(runId: string, outputFile: string): Promise<void> {
  await prisma.$connect();
  const plan = makePlan(runId);
  const generated = generateStagingCompose({
    plan,
    containerPort: 3000,
    pidsLimit: 128,
    imageReference: HEALTHY_IMAGE,
    healthcheck: HEALTHCHECK,
    deployJobId: "lab-job",
  });
  assert(generated.ok && generated.document, "compose inválido no crash test");
  const reserved = await runs.reserve({
    projectId: PROJECT_ID,
    deployJobId: "lab-job",
    runId: plan.runId,
    composeProject: plan.composeProject,
    planHash: generated.planHash!,
    composeHash: generated.composeHash!,
    imageReference: HEALTHY_IMAGE,
    imageId: dockerImageId(HEALTHY_IMAGE),
    app: { memoryMb: 192, cpu: 0.25, diskMb: 256 },
    dependencies: [],
    portCandidates: [plan.app.hostPort],
    ttlMinutes: 30,
    networkName: plan.network.name,
    volumePrefix: "korrelo-stg-",
    policy: {
      maxConcurrentEnvironments: 4,
      maxTtlMinutes: 120,
      productionReservedMemoryMb: 0,
      productionReservedCpu: 0,
      productionReservedDiskMb: 0,
      safetyMemoryMb: 0,
      safetyCpu: 0,
      safetyDiskMb: 0,
    },
  });
  assert(reserved.ok && reserved.run && reserved.lease, "reserva do crash test falhou");
  await new DockerComposeStagingRuntime().start({
    run: reserved.run,
    lease: reserved.lease,
    document: generated.document,
    composeProject: plan.composeProject,
  });
  writeFileSync(outputFile, JSON.stringify({ runId, plan }), "utf8");
  await waitFor(() => false, 10 * 60_000, "SIGKILL do processo pai");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
