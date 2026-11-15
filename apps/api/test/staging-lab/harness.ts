import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StagingExecutionService } from "../../src/modules/projects/application/staging-execution.service";
import { generateStagingCompose } from "../../src/modules/projects/domain/staging-compose";
import type {
  StagingExecutionRequest,
  StagingRuntimeAdapter,
  StagingRuntimeStartInput,
} from "../../src/modules/projects/domain/staging-execution";
import type { StagingPlan } from "../../src/modules/projects/domain/staging-planner";
import { planStaging } from "../../src/modules/projects/domain/staging-planner";
import type { StagingRun } from "../../src/modules/projects/domain/staging-run";
import { DockerPrebuiltImageVerifier } from "../../src/modules/projects/infrastructure/docker-prebuilt-image.verifier";
import { DockerComposeStagingRuntime } from "../../src/modules/projects/infrastructure/docker-staging-runtime";
import { WorkerLock } from "../../src/modules/projects/infrastructure/worker-lock";
import { LabRunRepository } from "./test-run-repository";

/**
 * HARNESS DE LABORATÓRIO DO STAGING ISOLADO.
 *
 * Usa o código real de: planner, compose, executor, WorkerLock, verificador de
 * imagem e runtime Docker/Compose. Somente o repositório de runs é substituído
 * por um adaptador de teste (o real é Prisma/SQLite).
 *
 * Execução: npx tsx test/staging-lab/harness.ts
 */

const PROJECT_ID = "lab-project";
const COMMIT_SHA = (process.env.LAB_COMMIT_SHA ?? "a".repeat(40)).trim().toLowerCase();
const HEALTHY_IMAGE = process.env.LAB_IMAGE_HEALTHY ?? "korrelo-lab-app:healthy";
const CRASH_IMAGE = process.env.LAB_IMAGE_CRASH ?? "korrelo-lab-app:crash";
const WORK_DIR = mkdtempSync(join(tmpdir(), "korrelo-lab-"));
const STATE_FILE = join(WORK_DIR, "state.json");
const EVIDENCE_FILE = process.env.LAB_EVIDENCE_FILE ?? join(WORK_DIR, "evidence.json");

process.env.KORRELO_LOCK_DIR = join(WORK_DIR, "locks");
process.env.KORRELO_STAGING_ISOLATED_EXECUTION = "true";

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

function inspectContainer(id: string): DockerInspect | null {
  const parsed = dockerJson<DockerInspect[]>(["inspect", id], true);
  if (!parsed) return null;
  return Array.isArray(parsed) ? parsed[0] ?? null : (parsed as unknown as DockerInspect);
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

function projectContainers(project: string): string[] {
  const stdout = docker(
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    true,
  );
  return stdout.split(/\r?\n/).filter(Boolean);
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

function makePlan(runId: string, dependencies: Array<Record<string, unknown>> = []): StagingPlan {
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
      portCandidates: [18080, 18081, 18082, 18083, 18084, 18085],
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
    portCandidates: plan.app ? [plan.app.hostPort] : [18080],
    ttlMinutes: 30,
    policy: {
      maxConcurrentEnvironments: 50,
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

function executor(): StagingExecutionService {
  return new StagingExecutionService(
    new LabRunRepository(STATE_FILE),
    new WorkerLock(),
    new DockerPrebuiltImageVerifier(),
    new DockerComposeStagingRuntime(),
    true,
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

function assertIsolation(input: StagingRuntimeStartInput): void {
  const ids = projectContainers(input.run.composeProject);
  assert(ids.length > 0, "nenhum container do staging encontrado após start");
  const appId = ids.find((id) => {
    const inspect = inspectContainer(id);
    return inspect?.Config.Labels["com.docker.compose.service"] === "app_staging";
  });
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
  const ports = app.HostConfig.PortBindings ?? {};
  const bindings = Object.values(ports).flat();
  assert(bindings.length === 1, `portas publicadas inesperadas: ${JSON.stringify(ports)}`);
  assert(bindings[0].HostIp === "127.0.0.1", `porta exposta fora do loopback: ${bindings[0].HostIp}`);
  assert(app.Config.Labels["korrelo.stagingRunId"] === input.run.runId, "label de run divergente");
  assert(app.Config.Labels["korrelo.ephemeral"] === "true", "label efêmera ausente");
  for (const entry of app.Config.Env) {
    const key = entry.split("=")[0] ?? "";
    assert(!/SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|PROD/i.test(key), `variável sensível no container: ${key}`);
  }
  assert(app.Image === input.run.imageId, "container não usa a imagem pré-construída verificada");

  const ephemeral = input.run.id;
  evidence.lastIsolation = {
    runId: ephemeral,
    networks,
    mounts: app.Mounts.map((mount) => `${mount.Type}:${mount.Destination}`),
    bindings,
    envKeys: app.Config.Env.map((entry) => entry.split("=")[0]),
  };
}

function assertingRuntime(inner: StagingRuntimeAdapter): StagingRuntimeAdapter {
  return {
    async start(input) {
      await inner.start(input);
      assertIsolation(input);
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

async function main(): Promise<void> {
  if (process.argv[2] === "--crash-child") {
    await crashChild(process.argv[3], process.argv[4]);
    return;
  }

  docker(["version"]);
  evidence.dockerVersion = docker(["version", "--format", "{{.Server.Version}}"]);
  evidence.images = {
    healthy: { reference: HEALTHY_IMAGE, id: dockerImageId(HEALTHY_IMAGE) },
    crash: { reference: CRASH_IMAGE, id: dockerImageId(CRASH_IMAGE) },
  };
  const before = inventory();

  await scenario("staging sem banco + health aprovado", async () => {
    const plan = makePlan(`run-nodb-${Date.now()}`);
    const runtime = new DockerComposeStagingRuntime();
    const result = await new StagingExecutionService(
      new LabRunRepository(STATE_FILE),
      new WorkerLock(),
      new DockerPrebuiltImageVerifier(),
      assertingRuntime(runtime),
      true,
    ).execute(executionRequest(plan));

    assert(
      result.ok && (result.status === "promoted" || result.status === "healthy"),
      `executor não concluiu: ${result.status} ${result.issues.join("; ")}`,
    );
    assert(result.status === "promoted" || result.status === "healthy", `status inesperado: ${result.status}`);
    assertGone(plan, "pós-cleanup");
    return { detail: `status=${result.status} composeHash=${(result.composeHash ?? "").slice(0, 12)}`, evidence: { runId: plan.runId } };
  });

  await scenario("imagem pré-construída não é reconstruída", async () => {
    const plan = makePlan(`run-prebuilt-${Date.now()}`);
    const beforeId = dockerImageId(HEALTHY_IMAGE);
    const result = await executor().execute(executionRequest(plan));
    assert(result.ok, `executor falhou: ${result.issues.join("; ")}`);
    const afterId = dockerImageId(HEALTHY_IMAGE);
    assert(beforeId === afterId, "image ID mudou após a execução");
    return { detail: `image ID preservado ${beforeId.slice(0, 19)}…`, evidence: { beforeId, afterId } };
  });

  await scenario("imagem ausente bloqueia antes de criar recursos", async () => {
    const plan = makePlan(`run-missing-${Date.now()}`);
    const request = executionRequest(plan, {
      compose: { imageReference: "korrelo-lab-app:does-not-exist" },
    });
    request.imageIdentity = { ...request.imageIdentity!, imageReference: "korrelo-lab-app:does-not-exist" };
    const result = await executor().execute(request);
    assert(!result.ok, "execução deveria falhar com imagem ausente");
    assert(result.status === "blocked", `status inesperado: ${result.status}`);
    assert(projectContainers(plan.composeProject).length === 0, "container criado apesar da falha");
    return { detail: `bloqueado: ${result.issues[0] ?? "sem detalhe"}` };
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
    request.commitSha = COMMIT_SHA;
    const result = await executor().execute(request);
    assert(!result.ok && result.status === "blocked", `deveria bloquear, veio ${result.status}`);
    assert(projectContainers(plan.composeProject).length === 0, "container criado apesar da identidade divergente");
    return { detail: `bloqueado: ${result.issues[0] ?? "sem detalhe"}` };
  });

  await scenario("porta ocupada falha e faz cleanup", async () => {
    const plan = makePlan(`run-port-${Date.now()}`);
    const port = plan.app.hostPort;
    const server = await listenOnPort(port);
    process.env.LAB_FORCE_PORT = String(port);
    try {
      const request = executionRequest(plan, { portCandidates: [port] });
      const result = await executor().execute(request);
      assert(!result.ok, "execução deveria falhar com porta ocupada");
      assert(result.status === "failed", `status inesperado: ${result.status}`);
      assertGone(plan, "porta ocupada");
      return { detail: `failed na porta ${port}; recursos removidos` };
    } finally {
      delete process.env.LAB_FORCE_PORT;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await scenario("recursos insuficientes bloqueiam antes do Docker", async () => {
    const plan = makePlan(`run-capacity-${Date.now()}`);
    process.env.LAB_FORCE_CAPACITY = "fail";
    try {
      const result = await executor().execute(executionRequest(plan));
      assert(!result.ok && result.status === "blocked", `deveria bloquear, veio ${result.status}`);
      assert(projectContainers(plan.composeProject).length === 0, "container criado sem capacidade");
      return { detail: `bloqueado: ${result.issues[0] ?? "sem detalhe"}` };
    } finally {
      delete process.env.LAB_FORCE_CAPACITY;
    }
  });

  await scenario("healthcheck reprovado não promove e faz cleanup", async () => {
    const plan = makePlan(`run-health-${Date.now()}`);
    const request = executionRequest(plan, {
      compose: { imageReference: CRASH_IMAGE },
    });
    request.imageIdentity = { ...request.imageIdentity!, imageReference: CRASH_IMAGE };
    const result = await executor().execute(request);
    assert(!result.ok, "execução deveria falhar no health");
    assert(result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "health reprovado");
    return { detail: `failed: ${result.issues[0] ?? "health reprovado"}` };
  });

  await scenario("falha na criação de recursos faz cleanup", async () => {
    const plan = makePlan(`run-create-${Date.now()}`);
    const request = executionRequest(plan, {
      mode: "local-build",
      compose: {
        imageReference: null,
        buildContext: "does-not-exist-lab-context",
        dockerfile: "Dockerfile",
      },
      imageIdentity: null,
    });
    const result = await executor().execute(request);
    assert(!result.ok, "execução deveria falhar no build");
    assert(result.status === "failed", `status inesperado: ${result.status}`);
    assertGone(plan, "falha de criação");
    return { detail: `failed: ${result.issues[0] ?? "build inválido"}` };
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
    const repo = new LabRunRepository(STATE_FILE);
    const reserved = await repo.reserve({
      projectId: plan.projectId,
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
      policy: {
        maxConcurrentEnvironments: 50,
        maxTtlMinutes: 120,
        productionReservedMemoryMb: 0,
        productionReservedCpu: 0,
        productionReservedDiskMb: 0,
        safetyMemoryMb: 0,
        safetyCpu: 0,
        safetyDiskMb: 0,
      },
    });
    assert(reserved.ok && reserved.run && reserved.lease, `reserva do teste falhou: ${reserved.issues.map((issue) => issue.message).join("; ")}`);
    await runtime.start({
      run: reserved.run,
      lease: reserved.lease,
      document: generated.document,
      composeProject: plan.composeProject,
    });
    try {
      const foreignRun: StagingRun = { ...reserved.run, runId: `${reserved.run.runId}-other` };
      const blocked = await runtime.cleanup({ run: foreignRun, lease: reserved.lease, reason: "teste" });
      assert(!blocked.ok, "cleanup aceitou ownership divergente");
      assert(projectContainers(plan.composeProject).length > 0, "cleanup removeu recursos com ownership divergente");
    } finally {
      const cleanup = await runtime.cleanup({ run: reserved.run, lease: reserved.lease, reason: "fim do teste" });
      assert(cleanup.ok, `cleanup correto falhou: ${cleanup.reason}`);
    }
    assertGone(plan, "ownership");
    return { detail: "cleanup divergente bloqueado; cleanup correto removeu tudo" };
  });

  await scenario("recuperação após encerramento inesperado", async () => {
    const runId = `run-crash-${Date.now()}`;
    const outputFile = join(WORK_DIR, "crash-run.json");
    const child = spawn(
      "npx",
      ["tsx", __filename, "--crash-child", runId, outputFile],
      { stdio: "inherit", env: { ...process.env } },
    );
    await waitFor(() => existsSync(outputFile), 60_000, "criação do staging no processo filho");
    const persisted = JSON.parse(readFileSync(outputFile, "utf8")) as { run: StagingRun; lease: unknown; plan: StagingPlan };
    persisted.run = {
      ...persisted.run,
      createdAt: new Date(persisted.run.createdAt),
      updatedAt: new Date(persisted.run.updatedAt),
      expiresAt: new Date(persisted.run.expiresAt),
    } as StagingRun;
    await waitFor(() => projectContainers(persisted.plan.composeProject).length > 0, 30_000, "container do crash test");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert(projectContainers(persisted.plan.composeProject).length > 0, "recursos desapareceram antes da recuperação");
    const cleanup = await new DockerComposeStagingRuntime().cleanup({
      run: persisted.run,
      lease: persisted.lease as never,
      reason: "recuperação após crash",
    });
    assert(cleanup.ok, `cleanup de recuperação falhou: ${cleanup.reason}`);
    assertGone(persisted.plan, "recuperação");
    return { detail: "processo morto com recursos ativos; cleanup escopado removeu tudo", evidence: { runId } };
  });

  const databaseCases = [
    {
      name: "staging com MongoDB temporário",
      dependency: {
        name: "mongo",
        kind: "mongodb",
        mode: "ephemeral",
        envKey: "MONGO_URL",
        resources: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
      },
      image: "mongo:7",
    },
    {
      name: "staging com PostgreSQL temporário",
      dependency: {
        name: "postgres",
        kind: "postgres",
        mode: "ephemeral",
        envKey: "DATABASE_URL",
        resources: { memoryMb: 256, cpu: 0.25, diskMb: 256 },
      },
      image: "postgres:16-alpine",
    },
  ];

  for (const testCase of databaseCases) {
    await scenario(testCase.name, async () => {
      const plan = makePlan(`run-db-${Date.now()}`, [testCase.dependency]);
      const runtime = new DockerComposeStagingRuntime();
      const request = executionRequest(plan, {
        compose: { dependencyImages: { [testCase.dependency.name]: testCase.image } },
      });
      const result = await new StagingExecutionService(
        new LabRunRepository(STATE_FILE),
        new WorkerLock(),
        new DockerPrebuiltImageVerifier(),
        assertingRuntime(runtime),
        true,
      ).execute(request);
      assert(result.ok, `executor falhou: ${result.issues.join("; ")}`);
      assertGone(plan, testCase.name);
      return { detail: `dependência ${testCase.dependency.kind} iniciada e removida com volumes` };
    });
  }

  await scenario("nenhum recurso fora do staging foi alterado", async () => {
    const after = inventory();
    const compare = (kind: "containers" | "networks" | "volumes") => {
      const beforeSet = withoutStaging(before[kind]).join("|");
      const afterSet = withoutStaging(after[kind]).join("|");
      assert(beforeSet === afterSet, `${kind} fora do staging mudaram`);
    };
    compare("containers");
    compare("networks");
    compare("volumes");
    return { detail: "inventário externo idêntico ao inicial" };
  });

  const failed = results.filter((result) => !result.ok);
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
  };
  writeFileSync(EVIDENCE_FILE, JSON.stringify({ ...evidence, results }, null, 2), "utf8");
  process.stdout.write(`\n${JSON.stringify(evidence.summary)}\n`);
  process.stdout.write(`evidências: ${EVIDENCE_FILE}\n`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function crashChild(runId: string, outputFile: string): Promise<void> {
  const plan = makePlan(runId);
  const repo = new LabRunRepository(STATE_FILE);
  const generated = generateStagingCompose({
    plan,
    containerPort: 3000,
    pidsLimit: 128,
    imageReference: HEALTHY_IMAGE,
    healthcheck: HEALTHCHECK,
    deployJobId: "lab-job",
  });
  assert(generated.ok && generated.document, "compose inválido no crash test");
  const reserved = await repo.reserve({
    projectId: plan.projectId,
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
    policy: {
      maxConcurrentEnvironments: 50,
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
  writeFileSync(outputFile, JSON.stringify({ run: reserved.run, lease: reserved.lease, plan }), "utf8");
  // Mantém o processo vivo sem cleanup até o pai enviar SIGKILL.
  await waitFor(() => false, 10 * 60_000, "SIGKILL do processo pai");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
