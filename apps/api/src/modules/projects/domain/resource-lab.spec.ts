import {
  assessLabConcurrency,
  buildLabProfile,
  classifyBuildOutcome,
  classifyStagingOutcome,
  computeLabInputsFingerprint,
  deriveLabConfidence,
  estimateLabDiskMb,
  planLabCleanup,
  planLabRun,
  type LabRawResult,
  type LabRunRequest,
} from "./resource-lab";
import { evaluateResourceProfile } from "./resource-profile";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;
const BASE_IMAGE = `sha256:${"e".repeat(64)}`;

function request(overrides: Partial<LabRunRequest> = {}): LabRunRequest {
  return {
    runId: "run-mesatta-001",
    projectId: "proj-mesatta",
    commitSha: "commit-abc",
    dockerfileSha256: SHA_A,
    lockfileSha256: SHA_B,
    baseImageId: BASE_IMAGE,
    cacheState: "cold",
    dockerVersion: "27.3.1",
    buildkitVersion: "v0.16.0",
    arch: "x86_64",
    host: {
      memAvailableMb: 4096,
      diskFreeMb: 50_000,
      cpuCount: 4,
      cgroupVersion: 2,
      arch: "x86_64",
      dockerVersion: "27.3.1",
      totalMemMb: 8192,
    },
    target: {
      arch: "x86_64",
      cgroupVersion: 2,
      dockerVersion: "27.3.1",
      totalMemMb: 8192,
    },
    limits: {
      buildMemoryMb: 1024,
      buildSwapMb: 1024,
      buildCpus: 1,
      stagingMemoryMb: 768,
      stagingSwapMb: 768,
      stagingCpus: 1,
      mongoMemoryMb: 512,
    },
    existingRunIds: [],
    ...overrides,
  };
}

function buildRaw(overrides: Partial<LabRawResult> = {}): LabRawResult {
  return {
    exitCode: 0,
    timedOut: false,
    oomKilled: false,
    oomEvents: 0,
    peakMb: 900,
    peakSource: "cgroup-peak",
    samples: 120,
    samplingComplete: true,
    durationMs: 1_200_000,
    pressureSomePeak: 0.2,
    pressureFullPeak: 0,
    ...overrides,
  };
}

function stagingRaw(overrides: Partial<LabRawResult> = {}): LabRawResult {
  return {
    exitCode: 0,
    timedOut: false,
    oomKilled: false,
    oomEvents: 0,
    peakMb: 400,
    peakSource: "cgroup-peak",
    samples: 90,
    samplingComplete: true,
    durationMs: 45_000,
    pressureSomePeak: 0.1,
    pressureFullPeak: 0,
    healthOk: true,
    ...overrides,
  };
}

function profile(overrides: {
  request?: Partial<LabRunRequest>;
  build?: Partial<LabRawResult>;
  staging?: Partial<LabRawResult>;
  imageDigest?: string | null;
} = {}) {
  const req = request(overrides.request);
  const plan = planLabRun(req);
  if (!plan.ok || !plan.plan) throw new Error("plano inválido no fixture");
  return buildLabProfile({
    request: req,
    plan: plan.plan,
    measuredAt: new Date(NOW - 60_000).toISOString(),
    buildRaw: buildRaw(overrides.build),
    stagingRaw: stagingRaw(overrides.staging),
    imageDigest: overrides.imageDigest === undefined ? DIGEST : overrides.imageDigest,
  });
}

describe("resource lab", () => {
  describe("plano e limites", () => {
    it("cria builder, imagem, staging e rede com nomes exclusivos da execução", () => {
      const result = planLabRun(request());
      const plan = result.plan!;

      expect(result.ok).toBe(true);
      expect(plan.resources.builderName).toBe("korrelo-lab-run-mesatta-builder");
      expect(plan.resources.imageTag).toContain("korrelo-lab-run-mesatta");
      expect(plan.resources.stagingContainerName).toBe("korrelo-lab-run-mesatta-staging");
      expect(plan.resources.networkName).toBe("korrelo-lab-run-mesatta-net");
      expect(plan.readOnlyEvidence).toBe(true);
    });

    it("exige swap igual à memória (swap proibido) e limites positivos", () => {
      const withSwap = planLabRun(
        request({ limits: { ...request().limits, buildSwapMb: 4096 } }),
      );
      const negative = planLabRun(
        request({ limits: { ...request().limits, stagingMemoryMb: 0 } }),
      );

      expect(withSwap.ok).toBe(false);
      expect(withSwap.issues.map((issue) => issue.message).join(" ")).toMatch(/swap/i);
      expect(negative.ok).toBe(false);
    });

    it("bloqueia quando o host não tem RAM, disco ou CPU suficientes", () => {
      const lowMemory = planLabRun(
        request({ host: { ...request().host, memAvailableMb: 1024 } }),
      );
      const lowDisk = planLabRun(request({ host: { ...request().host, diskFreeMb: 1000 } }));
      const lowCpu = planLabRun(request({ host: { ...request().host, cpuCount: 0 } }));

      expect(lowMemory.issues.map((issue) => issue.code)).toContain("LAB_HOST_MEMORY");
      expect(lowDisk.issues.map((issue) => issue.code)).toContain("LAB_HOST_DISK");
      expect(lowCpu.issues.map((issue) => issue.code)).toContain("LAB_HOST_CPU");
    });

    it("apresenta estimativa de disco separada por base, cache, export e reserva", () => {
      const estimate = estimateLabDiskMb();

      expect(estimate.baseImageMb).toBe(2048);
      expect(estimate.buildCacheMb).toBe(4096);
      expect(estimate.imageExportMb).toBe(1024);
      expect(estimate.reserveMb).toBe(4096);
      expect(estimate.totalMb).toBe(
        estimate.baseImageMb + estimate.buildCacheMb + estimate.imageExportMb + estimate.reserveMb,
      );
    });
  });

  describe("fingerprint", () => {
    it("é determinístico e não inclui o digest da imagem construída", () => {
      const first = computeLabInputsFingerprint(request());
      const second = computeLabInputsFingerprint(request());
      const withOtherDigest = computeLabInputsFingerprint(request());
      const changed = computeLabInputsFingerprint(request({ commitSha: "commit-new" }));

      expect(first).toBe(second);
      expect(first).toBe(withOtherDigest);
      expect(changed).not.toBe(first);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
    });

    it("registra o digest da imagem no perfil final sem circularidade", () => {
      const built = profile({ imageDigest: DIGEST });

      expect(built.fingerprint.imageDigest).toBe(DIGEST);
      expect(built.lab.inputsFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(built.lab.inputsFingerprint).not.toBe(built.fingerprint.imageDigest);
    });
  });

  describe("cache", () => {
    it("preserva cold e warm no relatório", () => {
      expect(profile({ request: { cacheState: "cold" } }).lab.cacheState).toBe("cold");
      expect(profile({ request: { cacheState: "warm" } }).lab.cacheState).toBe("warm");
    });

    it("recusa cache desconhecido no planejamento", () => {
      const result = planLabRun(request({ cacheState: "unknown" }));

      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("LAB_INPUT_INVALID");
    });
  });

  describe("classificação do build", () => {
    it("build bem-sucedido com amostragem completa", () => {
      expect(classifyBuildOutcome(buildRaw()).outcome).toBe("success");
    });

    it("OOM tem prioridade sobre timeout e exit 137", () => {
      const result = classifyBuildOutcome(
        buildRaw({ exitCode: 137, timedOut: true, oomKilled: true, oomEvents: 1 }),
      );

      expect(result.outcome).toBe("oom");
    });

    it("detecta OOM pelo log quando o cgroup não reporta", () => {
      const result = classifyBuildOutcome(
        buildRaw({ exitCode: 1, logTail: "npm ERR! JavaScript heap out of memory" }),
      );

      expect(result.outcome).toBe("oom");
    });

    it("falha externa de rede não é tratada como sucesso nem como OOM", () => {
      const result = classifyBuildOutcome(
        buildRaw({ exitCode: 1, logTail: "failed to solve: failed to fetch: ECONNRESET" }),
      );

      expect(result.outcome).toBe("external-failure");
    });

    it("timeout sem OOM é timeout", () => {
      expect(classifyBuildOutcome(buildRaw({ timedOut: true, exitCode: null })).outcome).toBe(
        "timeout",
      );
    });

    it("falha de medição não vira sucesso só porque o build terminou", () => {
      const noPeak = classifyBuildOutcome(buildRaw({ peakMb: null }));
      const incompleteSampling = classifyBuildOutcome(buildRaw({ samplingComplete: false }));

      expect(noPeak.outcome).toBe("collection-failure");
      expect(incompleteSampling.outcome).toBe("collection-failure");
    });
  });

  describe("classificação do staging", () => {
    it("staging saudável é sucesso", () => {
      expect(classifyStagingOutcome(stagingRaw()).outcome).toBe("success");
    });

    it("staging com OOM é OOM", () => {
      expect(
        classifyStagingOutcome(stagingRaw({ oomKilled: true, oomEvents: 1, exitCode: 137 })).outcome,
      ).toBe("oom");
    });

    it("staging sem healthcheck não é sucesso", () => {
      expect(classifyStagingOutcome(stagingRaw({ healthOk: false })).outcome).toBe(
        "external-failure",
      );
    });
  });

  describe("perfil final", () => {
    it("gera perfil válido de alta confiança quando tudo corresponde", () => {
      const built = profile();

      expect(built.confidence).toBe("high");
      expect(built.lab.buildOutcome).toBe("success");
      expect(built.lab.stagingOutcome).toBe("success");
      expect(built.lab.targetMatches).toBe(true);
      expect(built.lab.allowedForReservationReduction).toBe(false);
      const evaluation = evaluateResourceProfile(built, {
        projectId: built.fingerprint.projectId,
        commitSha: built.fingerprint.commitSha,
        dockerfileSha256: built.fingerprint.dockerfileSha256,
        lockfileSha256: built.fingerprint.lockfileSha256,
        imageDigest: built.fingerprint.imageDigest,
        buildMemoryLimitMb: built.fingerprint.buildMemoryLimitMb,
        stagingMemoryLimitMb: built.fingerprint.stagingMemoryLimitMb,
      }, { now: NOW });
      expect(evaluation.status).toBe("valid");
    });

    it("OOM no build rebaixa confiança e reprova o perfil", () => {
      const built = profile({ build: { oomKilled: true, oomEvents: 1, exitCode: 137 } });

      expect(built.lab.buildOutcome).toBe("oom");
      expect(deriveLabConfidence(built)).toBe("low");
      const evaluation = evaluateResourceProfile(built, {
        projectId: built.fingerprint.projectId,
        commitSha: built.fingerprint.commitSha,
        dockerfileSha256: built.fingerprint.dockerfileSha256,
        lockfileSha256: built.fingerprint.lockfileSha256,
        imageDigest: built.fingerprint.imageDigest,
        buildMemoryLimitMb: built.fingerprint.buildMemoryLimitMb,
        stagingMemoryLimitMb: built.fingerprint.stagingMemoryLimitMb,
      }, { now: NOW });
      expect(evaluation.status).toBe("unsafe");
      expect(evaluation.usable).toBe(false);
    });

    it("rebaixa para medium quando o ambiente de destino difere", () => {
      const built = profile({
        request: { target: { arch: "arm64", cgroupVersion: 2, dockerVersion: "27.3.1" } },
      });

      expect(built.lab.targetMatches).toBe(false);
      expect(built.confidence).toBe("medium");
    });
  });

  describe("execuções concorrentes", () => {
    it("recusa plano com outro run ativo", () => {
      const result = planLabRun(request({ existingRunIds: ["run-outro-999"] }));

      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("LAB_RUN_CONCURRENT");
    });

    it("reconhece exclusividade quando só existe o próprio run", () => {
      expect(assessLabConcurrency(["run-mesatta-001"], "run-mesatta-001")).toEqual({
        exclusive: true,
        others: [],
      });
      expect(assessLabConcurrency(["run-a", "run-mesatta-001"], "run-mesatta-001")).toEqual({
        exclusive: false,
        others: ["run-a"],
      });
    });
  });

  describe("limpeza segura", () => {
    it("planeja apenas remoções explícitas e nunca prune", () => {
      const cleanup = planLabCleanup({
        runId: "run-mesatta-001",
        builderName: "korrelo-lab-run-mesatta-builder",
        containers: ["korrelo-lab-run-mesatta-staging", "korrelo-lab-run-mesatta-mongo"],
        networks: ["korrelo-lab-run-mesatta-net"],
        volumes: ["korrelo-lab-run-mesatta-data"],
        imageTags: ["korrelo-lab-run-mesatta-mesatta:measure"],
      });

      expect(cleanup.ok).toBe(true);
      const flattened = cleanup.commands.map((command) => command.join(" "));
      expect(flattened.some((command) => command.includes("prune"))).toBe(false);
      expect(flattened).toContain("docker rm -f korrelo-lab-run-mesatta-staging");
      expect(flattened).toContain("docker buildx rm korrelo-lab-run-mesatta-builder");
    });

    it("falha inteira se algum recurso estiver fora do escopo do run", () => {
      const cleanup = planLabCleanup({
        runId: "run-mesatta-001",
        builderName: "korrelo-lab-run-mesatta-builder",
        containers: ["korrelo-lab-run-mesatta-staging", "mesatta-prod"],
        networks: [],
        volumes: [],
        imageTags: [],
      });

      expect(cleanup.ok).toBe(false);
      expect(cleanup.commands).toEqual([]);
      expect(cleanup.issues.join(" ")).toContain("mesatta-prod");
    });
  });
});
