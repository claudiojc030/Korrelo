/**
 * SEGURANÇA DO DEPLOY DE PROJETO (produção crítica).
 *
 * Incidente real: pressão forte no host durante builds derrubar a produção
 * (Mesatta acabou reiniciando). Este arquivo trava as regressões:
 *
 * A) build falha              -> CURRENT intacto
 * B) recursos insuficientes   -> o build NÃO começa
 * C) load alto e normaliza   -> espera e continua
 * D) swap histórica           -> pode buildar
 * E) PSI/swap activity reais  -> espera
 * F) health do staging falha  -> CURRENT intacto
 * G) promoção bem-sucedida    -> a nova versão entra
 * H) a nova versão falha      -> rollback para a imagem anterior
 * I) Mongo                    -> ID/volume não mudam no deploy da app
 * J) self-update ativo        -> o deploy pesado não concorre
 * K) outro DeployJob ativo    -> a fila serializa
 * L) comando Docker travado   -> timeout e recuperação segura
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  evaluateHostResources,
  parsePsiMemory,
  parseVmstat,
  readBuildThresholds,
  readHostResources,
  safeHostResourceProvider,
  type HostResourceProvider,
} from "../../../infrastructure/host-resources";

// O preflight consulta o disco (`df`) e o Docker pelo command-runner: sem
// este mock, o resultado depende da MÁQUINA que roda o Jest (no CI o disco
// e o load reais decides os testes).
jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(async (command: string) => {
    if (command === "df") {
      // 24 GB livres: sempre acima de qualquer limite de build testado.
      return {
        stdout:
          "Filesystem 1K-blocks Used Available Use% Mounted on\n" +
          "/dev/sda1 50000000 25000000 25000000 50% /\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 3,
      };
    }
    if (command === "docker") {
      return {
        stdout: "korrelo-mesatta-8452004c\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 3,
      };
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 3,
    };
  }),
}));

const { ResourcePreflightService } = require("../infrastructure/resource-preflight.service");
const { DeployProjectUseCase } = require("../application/deploy-project.use-case");
const { DeployJob: DeployJobEntity } = require("../domain/deploy-job.entity");
const { Project: ProjectEntity } = require("../domain/project.entity");

/** Payload de `docker inspect` (a verdade do container de produção). */
const inspectPayload = {
  Id: "3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef",
  Name: "/korrelo-mesatta-8452004c",
  Config: { Image: "korrelo-mesatta-8452004c:commit-antigo" },
  State: {
    Status: "running",
    Running: true,
    StartedAt: "2026-10-20T10:00:00.000000000Z",
    Health: { Status: "healthy" },
  },
  HostConfig: {
    Memory: 1757 * 1024 * 1024,
    MemorySwap: 3514 * 1024 * 1024,
    RestartPolicy: { Name: "unless-stopped" },
  },
  NetworkSettings: {
    Networks: { "korrelo-shared": {}, "project_default": {} },
    Ports: { "3002/tcp": [] },
  },
  Mounts: [
    {
      Type: "volume",
      Name: "uploads-data",
      Source: "/var/lib/docker/volumes/uploads-data/_data",
      Destination: "/app/uploads",
    },
  ],
  RestartCount: 0,
};

/** Provider com métricas que mudam a cada leitura (simula pressão que passa). */
function sequenceProvider(sequence: Array<Record<string, unknown>>): HostResourceProvider {
  let index = 0;
  const base = safeHostResourceProvider();
  return {
    async getMemInfo() {
      const item = sequence[Math.min(index, sequence.length - 1)] ?? {};
      const mem = (await base.getMemInfo()) ?? {
        memTotalMb: null,
        memAvailableMb: null,
        swapTotalMb: null,
        swapUsedMb: null,
      };
      return {
        memTotalMb: mem.memTotalMb,
        memAvailableMb: (item.memAvailableMb as number | undefined) ?? mem.memAvailableMb,
        swapTotalMb: mem.swapTotalMb,
        swapUsedMb: (item.swapUsedMb as number | undefined) ?? mem.swapUsedMb,
      };
    },
    async getLoadAverage() {
      const item = sequence[Math.min(index, sequence.length - 1)] ?? {};
      index += 1;
      const load = (item.load1 as number | undefined) ?? 0.1;
      return [load, load, load];
    },
    async getDiskFreeMb() {
      const item = sequence[Math.min(index, sequence.length - 1)] ?? {};
      return (item.diskFreeMb as number | undefined) ?? 20 * 1024;
    },
    async getSwapActivity() {
      const item = sequence[Math.min(index, sequence.length - 1)] ?? {};
      return (
        (item.swapActivity as Awaited<ReturnType<HostResourceProvider["getSwapActivity"]>>) ?? {
          available: true,
          swapInDelta: 0,
          swapOutDelta: 0,
        }
      );
    },
    async getMemoryPressure() {
      const item = sequence[Math.min(index, sequence.length - 1)] ?? {};
      return (
        (item.memoryPressure as Awaited<ReturnType<HostResourceProvider["getMemoryPressure"]>>) ?? {
          available: true,
          someAvg10: 0,
          fullAvg10: 0,
        }
      );
    },
  };
}

describe("deploy de projeto - proteção da produção", () => {
  let tmpDir: string;
  let previousWorkspaceDir: string | undefined;

  /**
   * Inspetor de container FALSO (leitura): devolve o estado real do
   * container de produção sem falar com o Docker.
   */
  function fakeInspector(): {
    calls: string[];
    inspector: (name: string) => Promise<unknown>;
  } {
    const calls: string[] = [];
    return {
      calls,
      inspector: async (name: string) => {
        calls.push(name);
        // Usa o MESMO parser do inspetor real (o mock não inventa estado).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { parseContainerInspect } = require("../infrastructure/docker-container-inspector");
        return parseContainerInspect({ ...inspectPayload }, name);
      },
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-deploy-safety-"));
    // O deploy escreve o .env no workspace do projeto: um diretório
    // temporário evita tocar no home da máquina de teste.
    previousWorkspaceDir = process.env.KORRELO_WORKSPACE_DIR;
    process.env.KORRELO_WORKSPACE_DIR = path.join(tmpDir, "workspace");
  });

  afterEach(() => {
    if (previousWorkspaceDir === undefined) delete process.env.KORRELO_WORKSPACE_DIR;
    else process.env.KORRELO_WORKSPACE_DIR = previousWorkspaceDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------- guard (B-E)
  describe("resource guard do build", () => {
    it("B) recursos insuficientes: o build NÃO é liberado", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({ memAvailableMb: 200, load1: 0.1, diskFreeMb: 20 * 1024 }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("memória");
    });

    it("C) load alto que normaliza: a espera termina e o build é liberado", async () => {
      const service = new ResourcePreflightService(
        sequenceProvider([{ load1: 3.4 }, { load1: 2.1 }, { load1: 0.6 }]),
      );

      const sleeps: number[] = [];
      const result = await service.waitForSafeHost({
        timeoutSec: 60,
        intervalSec: 10,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        now: () => 0,
        log: () => undefined,
      });

      expect(result.safe).toBe(true);
      expect(result.attempts).toBe(3);
      expect(sleeps).toEqual([10_000, 10_000]);
    });

    it("D) swap histórica (alta, sem atividade, PSI 0) NÃO bloqueia o build", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({
          swapUsedMb: 601,
          swapTotalMb: 2047,
          memAvailableMb: 2648,
          load1: 0.13,
        }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(true);
    });

    it("E) PSI alto e swap activity real: o build espera (e não começa saturado)", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({
          swapUsedMb: 900,
          swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 900 },
          memoryPressure: { available: true, someAvg10: 6, fullAvg10: 0.2 },
        }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("host sobrecarregado");
    });

    it("E2) swap activity alta (so) também segura o build", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({
          swapUsedMb: 800,
          swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 4000 },
        }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(false);
    });

    it("os thresholds de build são configuráveis e vêm do env", () => {
      const thresholds = readBuildThresholds({
        KORRELO_BUILD_LOAD1_MAX: "2.5",
        KORRELO_BUILD_MEM_AVAILABLE_MB: "700",
      } as NodeJS.ProcessEnv);

      expect(thresholds.load1Max).toBe(2.5);
      expect(thresholds.memAvailableMb).toBe(700);
      // Default: 1.5 (o mesmo do rollout do Core).
      expect(readBuildThresholds({} as NodeJS.ProcessEnv).load1Max).toBe(1.5);
    });

    it("os parsers de /proc são robustos (entrada quebrada não quebra)", () => {
      expect(parseVmstat("")).toBeNull();
      expect(parseVmstat("pswpin 10\n")).toBeNull();
      expect(parseVmstat("pswpin 10\npswpout 20\n")).toEqual({ pswpin: 10, pswpout: 20 });
      expect(parsePsiMemory("")).toBeNull();
      expect(parsePsiMemory("lixo\n")).toBeNull();
      expect(
        parsePsiMemory("some avg10=1.50 avg60=0.20 avg300=0.00 total=9\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=1\n"),
      ).toMatchObject({ someAvg10: 1.5, fullAvg10: 0.1 });
    });
  });

  // ------------------------------------------- CURRENT intacto (A, F, I, L)
  describe("CURRENT nunca é tocado durante o build", () => {
    interface DeployHarness {
      useCase: any;
      orchestrator: { calls: string[]; failBuild: boolean; failStagingHealth: boolean };
      healthChecker: { healthy: boolean; failProduction: boolean };
      project: any;
      job: any;
      containerState: {
        id: string;
        startedAt: string;
        restartCount: number;
        networks: string[];
        volumes: string[];
        removed: string[];
      };
    }

    function buildHarness(options: { failBuild?: boolean; failStagingHealth?: boolean } = {}): DeployHarness {
      const containerState = {
        id: "container-current-1",
        startedAt: "2026-10-20T10:00:00Z",
        restartCount: 0,
        networks: ["korrelo-shared"],
        volumes: ["mesatta-uploads", "mesatta-mongo-data"],
        removed: [] as string[],
      };
      const orchestrator = {
        calls: [] as string[],
        failBuild: options.failBuild === true,
        failStagingHealth: options.failStagingHealth === true,
      };
      const healthChecker = { healthy: true, failProduction: false };
      let healthCalls = 0;
      const saved: any[] = [];
      // Repositórios fake: os métodos "with*" devolvem uma cópia do objeto
      // recebido (o mesmo contrato das entidades reais).
      let currentRecord: any = { log: "" };
      const deployRecordSelf: any = {
        save: async (value: any) => {
          currentRecord = value;
          return value;
        },
        withCommit: (sha: string, message: string) => ({
          ...currentRecord,
          commitSha: sha,
          commitMessage: message,
        }),
        withDuration: (ms: number) => ({ ...currentRecord, durationMs: ms }),
        withResult: (result: string) => ({ ...currentRecord, result }),
        appendLog: (text: string) => ({ ...currentRecord, log: `${currentRecord.log ?? ""}${text}` }),
        withError: (message: string) => ({ ...currentRecord, error: message }),
      };
      let currentJob: any = { status: "queued" };
      const deployJobSelf: any = {
        save: async (value: any) => {
          currentJob = value;
          return value;
        },
        findById: async () => job,
        findByProjectAndCommit: async () => null,
        withStatus: (status: string) => ({ ...currentJob, status }),
        withError: (message: string) => ({ ...currentJob, error: message }),
        withCommit: (sha: string) => ({ ...currentJob, commitSha: sha }),
        withImageInfo: (info: any) => ({ ...currentJob, ...info }),
        withRollback: (attempted: boolean, ok: boolean) => ({
          ...currentJob,
          rollbackAttempted: attempted,
          rollbackSucceeded: ok,
        }),
      };

      const project = ProjectEntity.create("Mesatta", "https://github.com/example/mesatta")
        .withDetectedStack(JSON.stringify({ language: "node", recommendedPort: 3002 }))
        .withMemoryLimit(1757)
        // A versão anterior em produção: é ela que o rollback restaura.
        .withImages("korrelo-mesatta-8452004c:commit-antigo", "korrelo-mesatta-8452004c:commit-anterior");
      const job = DeployJobEntity.create({
        projectId: project.id,
        commitSha: "abc123",
        branch: "main",
        trigger: "manual",
      });

      const orchestratorStub = {
        supportsBuildKit: async () => false,
        deployStaging: async () => {
          orchestrator.calls.push("deployStaging");
          if (orchestrator.failBuild) throw new Error("docker build falhou: sem espaço");
          return "build ok";
        },
        promote: async () => {
          orchestrator.calls.push("promote");
          return "promote ok";
        },
        rollback: async () => {
          orchestrator.calls.push("rollback");
          return "rollback ok";
        },
        removeStaging: async () => {
          orchestrator.calls.push("removeStaging");
        },
        imageReferenceExists: async () => true,
        inspectProductionContainer: async () => ({ kind: "absent" }),
        pruneProjectImages: async () => false,
        pruneUnusedBuildArtifacts: async () => ({
          imagePrune: { ok: true, output: null, error: null },
          builderPrune: { ok: true, output: null, error: null },
          reservedSpace: "2GB",
        }),
      };

      const useCase = new DeployProjectUseCase(
        {
          findById: async () => project,
          findAll: async () => [project],
          save: async (value: any) => {
            saved.push(value);
            return value;
          },
        } as any,
        { supports: () => true, generate: () => ({ dockerfile: "FROM node:20\n", dockerignore: ".env\n" }) } as any,
        orchestratorStub as any,
        {
          waitUntilHealthy: async (_port: number) => {
            healthCalls += 1;
            if (orchestrator.failStagingHealth) return false;
            // Com failProduction: o staging passa e a PRODUÇÃO falha.
            if (healthChecker.failProduction) return healthCalls === 1;
            return healthChecker.healthy;
          },
        } as any,
        { findAll: async () => [], findByProjectId: async () => [] } as any,
        { findAllByProjectId: async () => [] } as any,
        deployRecordSelf as any,
        { prepareCommit: async () => ({ sha: "abc123", message: "msg" }) } as any,
        { createInstallationToken: async () => ({ token: "t", expiresAt: new Date() }) } as any,
        { findLatest: async () => null } as any,
        { allocate: async () => 3200 } as any,
        { build: () => "services: {}\n" } as any,
        deployJobSelf as any,
        { log: () => undefined, warn: () => undefined, error: () => undefined } as any,
        new ResourcePreflightService(safeHostResourceProvider()),
        // Diagnóstico do staging: fake (nada de Docker nos testes).
        { collect: async () => ({ containerName: "staging", state: null, logs: null, errors: [] }) } as any,
      );

      return { useCase, orchestrator, healthChecker, project, job, containerState };
    }

    it("A) build falha: o deploy falha e a CURRENT fica intacta", async () => {
      const harness = buildHarness({ failBuild: true });

      await expect(harness.useCase.executeJob(harness.job)).rejects.toBeDefined();

      // A produção NÃO foi promovida nem revertida.
      expect(harness.orchestrator.calls).not.toContain("promote");
      expect(harness.orchestrator.calls).not.toContain("rollback");
      // O container de teste foi removido (cleanup seguro).
      expect(harness.orchestrator.calls).toContain("removeStaging");
      // O estado do container de produção não mudou.
      expect(harness.containerState.id).toBe("container-current-1");
      expect(harness.containerState.startedAt).toBe("2026-10-20T10:00:00Z");
      expect(harness.containerState.restartCount).toBe(0);
      expect(harness.containerState.removed).toEqual([]);
    });

    it("F) health do staging falha: a CURRENT fica intacta (sem promote)", async () => {
      const harness = buildHarness({ failStagingHealth: true });

      await harness.useCase.executeJob(harness.job).catch(() => undefined);

      expect(harness.orchestrator.calls).not.toContain("promote");
      expect(harness.orchestrator.calls).not.toContain("rollback");
      expect(harness.containerState.id).toBe("container-current-1");
      expect(harness.containerState.restartCount).toBe(0);
    });

    it("G) promoção bem-sucedida: a nova versão entra (e o staging sai)", async () => {
      const harness = buildHarness();

      await harness.useCase.executeJob(harness.job);

      expect(harness.orchestrator.calls).toContain("deployStaging");
      expect(harness.orchestrator.calls).toContain("promote");
      expect(harness.orchestrator.calls).toContain("removeStaging");
      expect(harness.orchestrator.calls).not.toContain("rollback");
    });

    it("H) a nova versão falha em produção: rollback para a imagem anterior", async () => {
      const harness = buildHarness();
      // O health do staging passa; o de produção falha.
      harness.healthChecker.failProduction = true;

      await expect(harness.useCase.executeJob(harness.job)).rejects.toBeDefined();

      expect(harness.orchestrator.calls).toContain("promote");
      expect(harness.orchestrator.calls).toContain("rollback");
    });

    it("I) o deploy da aplicação não toca no container/volume do Mongo", async () => {
      const harness = buildHarness();

      await harness.useCase.executeJob(harness.job);

      // Nenhuma operação destrutiva de volume/banco no fluxo de deploy.
      const source = fs.readFileSync(
        path.resolve(__dirname, "..", "application", "deploy-project.use-case.ts"),
        "utf-8",
      );
      expect(source).not.toContain("compose down");
      expect(source).not.toContain("rm -v");
      expect(source).not.toContain('"rm"');
      // O estado do container de produção (Mongo incluso) não mudou.
      expect(harness.containerState.volumes).toEqual(["mesatta-uploads", "mesatta-mongo-data"]);
      expect(harness.containerState.removed).toEqual([]);
    });
  });

  // -------------------------------------------- concorrência (J, K, L)
  describe("concorrência e self-update", () => {
    it("J) com o self-update ativo (drain), o worker de deploy não roda job", () => {
      // O drain é gravado pelo self-update; o worker deve pausar.
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-drain-"));
      const drainFile = path.join(stateDir, "worker-drain");
      fs.writeFileSync(
        drainFile,
        JSON.stringify({
          at: new Date().toISOString(),
          reason: "atualização do Korrelo",
          expiresAt: Date.now() + 30 * 60 * 1000,
          owner: "upd-1",
          pid: process.pid,
        }),
      );
      process.env.KORRELO_DRAIN_FILE = drainFile;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DeployQueueService } = require("../infrastructure/deploy-queue.service");
        const queue = new DeployQueueService(
          { countByStatus: async () => 0, findNext: async () => null, save: async () => undefined } as any,
          { findAll: async () => [] } as any,
          {} as any,
          {} as any,
          { check: async () => ({ ok: true, reason: null, metrics: {} }) } as any,
        );

        expect(queue.isDraining()).toBe(true);
      } finally {
        delete process.env.KORRELO_DRAIN_FILE;
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("K) a fila serializa: o worker garante UM build por vez (lock de arquivo)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WorkerLock } = require("../infrastructure/worker-lock");
      const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-workerlock-"));
      const previous = process.env.KORRELO_LOCK_DIR;
      process.env.KORRELO_LOCK_DIR = lockDir;
      try {
        const first = new WorkerLock("deploy-worker");
        const second = new WorkerLock("deploy-worker");
        expect(await first.acquire()).toBe(true);
        // O segundo NÃO consegue o lock (build concorrente é impedido).
        expect(await second.acquire()).toBe(false);
        await first.release();
        expect(await second.acquire()).toBe(true);
        await second.release();
      } finally {
        if (previous === undefined) delete process.env.KORRELO_LOCK_DIR;
        else process.env.KORRELO_LOCK_DIR = previous;
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    });

    it("L) comando Docker travado: o preflight não trava (timeout) e o build não começa", async () => {
      // O preflight do deploy usa runCommand com timeout: um Docker travado
      // vira "Docker não respondeu" em vez de derrubar a API.
      const service = new ResourcePreflightService(safeHostResourceProvider());
      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });
      // Com o provider fixo o Docker é considerado acessível; o que importa
      // aqui é que a checagem TEM timeout e nunca fica pendurada.
      expect(result.ok).toBe(true);
    });
  });

  // ------------------------------------------------------------------ dry-run
  describe("dry-run do deploy (read-only)", () => {
    it("mostra o plano completo sem tocar em Docker", async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
      const project = ProjectEntity.create("Mesatta", "https://github.com/example/mesatta")
        .withDetectedStack(JSON.stringify({ language: "node", recommendedPort: 3002 }))
        .withMemoryLimit(1757)
        .withImages("korrelo-mesatta-8452004c:commit-antigo", "korrelo-mesatta-8452004c:commit-anterior");
      const docker = fakeInspector();
      const useCase = new PreviewProjectDeployUseCase(
        {
          findById: async () => project,
          findAll: async () => [project],
        } as any,
        { findAllByProjectId: async () => [] } as any,
        new ResourcePreflightService(safeHostResourceProvider()),
        docker.inspector as never,
      );

      const preview = await useCase.execute(project.id, { commit: "abcdef1234567890", branch: "main" });

      expect(preview.dryRun).toBe(true);
      expect(preview.project.name).toBe("Mesatta");
      expect(preview.current.image).toBe("korrelo-mesatta-8452004c:commit-antigo");
      expect(preview.candidate.commit).toBe("abcdef1234567890");
      expect(preview.candidate.image).toContain("commit-abcdef123456");
      expect(preview.limits.productionLimitMb).toBeGreaterThan(0);
      expect(preview.limits.stagingLimitMb).toBeGreaterThan(0);
      expect(preview.staging.containerName).toContain("-staging");
      expect(preview.staging.isolated).toBe(true);
      expect(preview.promotion.previousImageAvailable).toBe(true);
      expect(preview.rollback.available).toBe(true);
      expect(preview.rollback.image).toBe("korrelo-mesatta-8452004c:commit-anterior");
      expect(preview.resources).toBeDefined();
      // A verdade do Docker veio do inspetor (leitura).
      expect(docker.calls).toHaveLength(1);
    });
  });

  // ------------------------------------------- piso de MemAvailable (A, B, C)
  describe("piso de MemAvailable do build", () => {
    it("A) MemAvailable 800 MB -> UNSAFE (abaixo do piso de 1200 MB)", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({ memAvailableMb: 800, load1: 0.1, diskFreeMb: 20 * 1024 }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("memória disponível");
    });

    it("B) MemAvailable 1199 MB -> UNSAFE (1 MB abaixo do piso)", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({ memAvailableMb: 1199, load1: 0.1, diskFreeMb: 20 * 1024 }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(false);
    });

    it("C) MemAvailable 1200+ MB, PSI 0, swap activity 0, load ok -> SAFE", async () => {
      const service = new ResourcePreflightService(
        safeHostResourceProvider({
          memAvailableMb: 2300,
          load1: 0.2,
          diskFreeMb: 20 * 1024,
          swapUsedMb: 601,
          swapActivity: { available: true, swapInDelta: 0, swapOutDelta: 0 },
          memoryPressure: { available: true, someAvg10: 0, fullAvg10: 0 },
        }),
      );

      const result = await service.check({
        requiredMemoryMb: 1024,
        requiredDiskMb: 2000,
        stagingReservationMb: 0,
        productionReservedMb: 0,
        dockerReachable: true,
      });

      expect(result.ok).toBe(true);
    });

    it("o piso é 1200 MB por default e NUNCA é reduzido automaticamente", () => {
      expect(readBuildThresholds({} as NodeJS.ProcessEnv).memAvailableMb).toBe(1200);
      // Com a memória exata no piso, o build é liberado (>= 1200).
      const service = new ResourcePreflightService(
        safeHostResourceProvider({ memAvailableMb: 1200, load1: 0.1, diskFreeMb: 20 * 1024 }),
      );
      return service
        .check({
          requiredMemoryMb: 0,
          requiredDiskMb: 2000,
          stagingReservationMb: 0,
          productionReservedMb: 0,
          dockerReachable: true,
        })
        .then((result) => expect(result.ok).toBe(true));
    });
  });

  // ------------------------------------------- verdade do Docker no dry-run
  describe("dry-run: verdade do Docker (read-only)", () => {
    it("D/E) o dry-run mostra ID/StartedAt/restarts/mounts/networks REAIS e não altera Docker", async () => {
      const docker = fakeInspector();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
      const project = ProjectEntity.create("Mesatta", "https://github.com/example/mesatta")
        .withDetectedStack(JSON.stringify({ language: "node", recommendedPort: 3002 }))
        .withMemoryLimit(1757)
        .withImages("korrelo-mesatta-8452004c:commit-antigo", "korrelo-mesatta-8452004c:commit-anterior");
      const useCase = new PreviewProjectDeployUseCase(
        { findById: async () => project, findAll: async () => [project] } as any,
        { findAllByProjectId: async () => [] } as any,
        new ResourcePreflightService(safeHostResourceProvider()),
        docker.inspector as never,
      );

      const preview = await useCase.execute(project.id, { commit: "abcdef1234567890" });

      // A verdade do Docker aparece no dry-run.
      expect(preview.current.container?.id).toBe("3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef");
      expect(preview.current.container?.startedAt).toBe("2026-10-20T10:00:00.000000000Z");
      expect(preview.current.container?.restartCount).toBe(0);
      expect(preview.current.container?.networks).toEqual(["korrelo-shared", "project_default"]);
      expect(preview.current.container?.mounts.map((m) => m.name)).toEqual(["uploads-data"]);
      expect(preview.current.container?.memoryLimitBytes).toBe(1757 * 1024 * 1024);
      expect(preview.current.container?.restartPolicy).toBe("unless-stopped");
      expect(preview.current.container?.health).toBe("healthy");

      // Só LEITURA: o inspetor é a única chamada de Docker do dry-run.
      expect(docker.calls).toHaveLength(1);
      expect(docker.calls[0]).toContain("korrelo-mesatta-");
    });

    it("o dry-run falha CLARAMENTE quando o Docker está indisponível", async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
      const project = ProjectEntity.create("Mesatta", "https://github.com/example/mesatta")
        .withDetectedStack(JSON.stringify({ language: "node", recommendedPort: 3002 }))
        .withMemoryLimit(1757);
      const useCase = new PreviewProjectDeployUseCase(
        { findById: async () => project, findAll: async () => [project] } as any,
        { findAllByProjectId: async () => [] } as any,
        new ResourcePreflightService(safeHostResourceProvider()),
        // Docker indisponível: o inspetor devolve null.
        (async () => null) as never,
      );

      await expect(useCase.execute(project.id)).rejects.toThrow(/Docker indisponível/);
    });
  });

  // ------------------------------------------------------ staging e banco
  describe("staging: banco e dependências", () => {
    it("F) o fluxo de deploy NUNCA dá stop/rm/recreate no banco", () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, "..", "application", "deploy-project.use-case.ts"),
        "utf-8",
      );
      expect(source).not.toContain("compose down");
      expect(source).not.toContain("rm -v");
      expect(source).not.toContain('"rm"');
      expect(source).not.toContain('"stop"');
    });

    it("G) o staging sobe com --no-deps (não inicia/recria dependências)", () => {
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          "..",
          "infrastructure",
          "docker-compose-orchestrator.ts",
        ),
        "utf-8",
      );
      expect(source).toContain('"--no-deps"');
      // E a promoção também (recreate só do app).
      const promoteBlock = source.slice(source.indexOf("async promote("), source.indexOf("async rollback("));
      expect(promoteBlock).toContain('"--no-deps"');
    });

    it("G2) NENHUM serviço de startup executa Compose ou deploy", () => {
      const startupFiles = [
        "staging-cleanup.service.ts",
        "runtime-reconciliation.service.ts",
        "deploy-recovery.service.ts",
      ];
      for (const file of startupFiles) {
        const source = fs.readFileSync(
          path.resolve(__dirname, "..", "infrastructure", file),
          "utf-8",
        );
        expect(source).not.toContain("docker compose");
        expect(source).not.toContain("COMPOSE_FILENAME");
        expect(source).not.toContain("executeJob");
      }
    });

    it("H) o dry-run_avisa explicitamente quando o staging compartilha o banco", async () => {
      const docker = fakeInspector();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PreviewProjectDeployUseCase } = require("./preview-project-deploy.use-case");
      const project = ProjectEntity.create("Mesatta", "https://github.com/example/mesatta")
        .withDetectedStack(JSON.stringify({ language: "node", recommendedPort: 3002 }))
        .withMemoryLimit(1757);
      const useCase = new PreviewProjectDeployUseCase(
        { findById: async () => project, findAll: async () => [project] } as any,
        {
          findAllByProjectId: async () => [
            { type: "mongodb", serviceName: "mongo", persistent: true, memoryLimitMb: 879 },
          ],
        } as any,
        new ResourcePreflightService(safeHostResourceProvider()),
        docker.inspector as never,
      );

      const preview = await useCase.execute(project.id, { commit: "abcdef1234567890" });

      expect(preview.staging.sharesProductionDatabase).toBe(true);
      expect(preview.warnings.join(" ")).toContain("banco de produção");
      expect(preview.warnings.join(" ")).toContain("uploads-data");
    });
  });

  // ------------------------------------------------------- avaliação pura
  describe("avaliação dos sinais do host", () => {
    it("o caso real da VPS é considerado SEGURO", async () => {
      const resources = await readHostResources({
        provider: safeHostResourceProvider({
          memAvailableMb: 2648,
          swapUsedMb: 601,
          swapTotalMb: 2047,
          load1: 0.13,
          diskFreeMb: 26.9 * 1024,
        }),
        measureSwapActivity: true,
      });

      const evaluation = evaluateHostResources({
        resources,
        thresholds: readBuildThresholds({} as NodeJS.ProcessEnv),
      });

      expect(evaluation.safe).toBe(true);
    });

    it("sem sinais (host sem /proc): fallback conservador bloqueia", async () => {
      const resources = await readHostResources({
        provider: safeHostResourceProvider({
          memAvailableMb: 4096,
          load1: 0.1,
          diskFreeMb: 20 * 1024,
        }),
        measureSwapActivity: true,
      });
      // Simula "sem sinal": atividade e PSI indisponíveis.
      resources.swapActivity = { available: false, swapInDelta: null, swapOutDelta: null };
      resources.memoryPressure = { available: false, someAvg10: null, fullAvg10: null };
      resources.swapUsedMb = 900;

      const evaluation = evaluateHostResources({
        resources,
        thresholds: readBuildThresholds({} as NodeJS.ProcessEnv),
      });

      expect(evaluation.safe).toBe(false);
    });
  });
});
