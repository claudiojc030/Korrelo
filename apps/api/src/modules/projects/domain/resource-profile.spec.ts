import {
  DEFAULT_PROFILE_TTL_MS,
  RESOURCE_PROFILE_SCHEMA_VERSION,
  computeProfileFingerprint,
  deriveProfileConfidence,
  evaluateResourceProfile,
  selectLatestCompatibleProfile,
  type ExpectedProfileKey,
  type ResourceProfile,
} from "./resource-profile";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;

function expected(overrides: Partial<ExpectedProfileKey> = {}): ExpectedProfileKey {
  return {
    projectId: "proj-mesatta",
    commitSha: "commit-abc",
    dockerfileSha256: SHA_A,
    lockfileSha256: SHA_B,
    imageDigest: DIGEST,
    buildMemoryLimitMb: 1024,
    stagingMemoryLimitMb: 768,
    ...overrides,
  };
}

function profile(overrides: Partial<ResourceProfile> = {}): ResourceProfile {
  const base: ResourceProfile = {
    schemaVersion: RESOURCE_PROFILE_SCHEMA_VERSION,
    fingerprint: {
      projectId: "proj-mesatta",
      commitSha: "commit-abc",
      dockerfileSha256: SHA_A,
      lockfileSha256: SHA_B,
      imageDigest: DIGEST,
      buildMemoryLimitMb: 1024,
      stagingMemoryLimitMb: 768,
    },
    measuredAt: new Date(NOW - DAY_MS).toISOString(),
    validUntil: null,
    environment: "lab",
    run: { id: "run-1", exclusive: true, concurrentMeasurements: 0 },
    build: {
      memoryLimitMb: 1024,
      limitEnforced: true,
      peakMb: 900,
      oomKilled: false,
      oomEvents: 0,
      psiSomePeak: 0.2,
      psiFullPeak: 0,
      durationMs: 1_200_000,
      complete: true,
      stepPeaks: [{ step: "npm ci", peakMb: 700 }],
    },
    staging: {
      memoryLimitMb: 768,
      bootPeakMb: 380,
      steadyPeakMb: 240,
      peakMb: 400,
      oomKilled: false,
      oomEvents: 0,
      psiSomePeak: 0.1,
      psiFullPeak: 0,
      healthOk: true,
      bootDurationMs: 45_000,
      complete: true,
    },
    confidence: "high",
  };

  const merged: ResourceProfile = { ...base, ...overrides };
  // A confiança é sempre derivada; o objeto de teste não pode "forçar" high.
  return { ...merged, confidence: deriveProfileConfidence(merged) };
}

describe("resource profile", () => {
  describe("perfil válido", () => {
    it("aceita um perfil de laboratório completo e exclusivo", () => {
      const evaluation = evaluateResourceProfile(profile(), expected(), { now: NOW });

      expect(evaluation.status).toBe("valid");
      expect(evaluation.usable).toBe(true);
      expect(evaluation.confidence).toBe("high");
      expect(evaluation.reasons).toEqual([]);
    });

    it("mantém fingerprint determinístico independente da ordem das chaves", () => {
      const first = computeProfileFingerprint({
        projectId: "p",
        commitSha: "c",
        dockerfileSha256: SHA_A,
        lockfileSha256: null,
        imageDigest: null,
        buildMemoryLimitMb: 1024,
        stagingMemoryLimitMb: 768,
      });
      const second = computeProfileFingerprint({
        stagingMemoryLimitMb: 768,
        buildMemoryLimitMb: 1024,
        imageDigest: null,
        lockfileSha256: null,
        dockerfileSha256: SHA_A,
        commitSha: "c",
        projectId: "p",
      });

      expect(first).toBe(second);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rebaixa para medium quando o limite de build não era aplicado por cgroup", () => {
      const candidate = profile();
      candidate.build.limitEnforced = false;
      candidate.confidence = deriveProfileConfidence(candidate);

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("valid");
      expect(evaluation.confidence).toBe("medium");
      expect(evaluation.usable).toBe(true);
    });
  });

  describe("perfil ausente ou inválido", () => {
    it("trata perfil ausente como indisponível", () => {
      const evaluation = evaluateResourceProfile(null, expected(), { now: NOW });

      expect(evaluation.status).toBe("absent");
      expect(evaluation.usable).toBe(false);
    });

    it("trata JSON corrompido como inválido sem lançar", () => {
      const evaluation = evaluateResourceProfile(
        { schemaVersion: 1, fingerprint: {} } as unknown as ResourceProfile,
        expected(),
        { now: NOW },
      );

      expect(evaluation.status).toBe("invalid");
      expect(evaluation.usable).toBe(false);
    });

    it("rejeita schemaVersion desconhecida", () => {
      const evaluation = evaluateResourceProfile(profile({ schemaVersion: 99 }), expected(), {
        now: NOW,
      });

      expect(evaluation.status).toBe("invalid");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("incompatibilidade de identidade", () => {
    it("rejeita perfil de outro projeto", () => {
      const other = profile();
      other.fingerprint.projectId = "proj-outro";

      const evaluation = evaluateResourceProfile(other, expected(), { now: NOW });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.usable).toBe(false);
      expect(evaluation.reasons).toContain("perfil pertence a outro projeto");
    });

    it("invalida quando o commit muda", () => {
      const evaluation = evaluateResourceProfile(profile(), expected({ commitSha: "commit-new" }), {
        now: NOW,
      });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.reasons).toContain("commit diferente");
    });

    it("invalida quando o Dockerfile muda", () => {
      const evaluation = evaluateResourceProfile(profile(), expected({ dockerfileSha256: SHA_C }), {
        now: NOW,
      });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.reasons).toContain("Dockerfile diferente");
    });

    it("invalida quando o lockfile muda", () => {
      const evaluation = evaluateResourceProfile(profile(), expected({ lockfileSha256: SHA_C }), {
        now: NOW,
      });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.reasons).toContain("lockfile diferente");
    });

    it("invalida quando o digest da imagem muda", () => {
      const evaluation = evaluateResourceProfile(
        profile(),
        expected({ imageDigest: `sha256:${"e".repeat(64)}` }),
        { now: NOW },
      );

      expect(evaluation.status).toBe("stale");
      expect(evaluation.reasons).toContain("digest de imagem diferente");
    });

    it("invalida quando os limites de build ou staging mudam", () => {
      const buildChanged = evaluateResourceProfile(
        profile(),
        expected({ buildMemoryLimitMb: 2048 }),
        { now: NOW },
      );
      const stagingChanged = evaluateResourceProfile(
        profile(),
        expected({ stagingMemoryLimitMb: 512 }),
        { now: NOW },
      );

      expect(buildChanged.status).toBe("stale");
      expect(buildChanged.reasons).toContain("limite de build diferente");
      expect(stagingChanged.status).toBe("stale");
      expect(stagingChanged.reasons).toContain("limite de staging diferente");
    });
  });

  describe("OOM", () => {
    it("marca perfil inseguro quando o build sofreu OOM", () => {
      const candidate = profile();
      candidate.build.oomKilled = true;
      candidate.build.oomEvents = 1;

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("unsafe");
      expect(evaluation.usable).toBe(false);
      expect(evaluation.confidence).toBe("low");
    });

    it("marca perfil inseguro quando o staging sofreu OOM", () => {
      const candidate = profile();
      candidate.staging.oomEvents = 2;

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("unsafe");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("medição incompleta ou falha de leitura", () => {
    it("rejeita medição sem pico real do build", () => {
      const candidate = profile();
      candidate.build.peakMb = null;

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("incomplete");
      expect(evaluation.usable).toBe(false);
      expect(evaluation.confidence).toBe("low");
    });

    it("rejeita falha de leitura de cgroup no staging", () => {
      const candidate = profile();
      candidate.staging.peakMb = null;
      candidate.staging.complete = false;

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("incomplete");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("dados inconsistentes", () => {
    it("rejeita pico de staging acima do limite do container", () => {
      const candidate = profile();
      candidate.staging.peakMb = 2048;

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("inconsistent");
      expect(evaluation.usable).toBe(false);
    });

    it("rejeita data de medição no futuro", () => {
      const candidate = profile({ measuredAt: new Date(NOW + DAY_MS).toISOString() });

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("inconsistent");
      expect(evaluation.usable).toBe(false);
    });

    it("rejeita validade ilegível", () => {
      const candidate = profile({ validUntil: "amanhã" });

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("inconsistent");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("execuções concorrentes", () => {
    it("invalida perfil quando outro build rodava na mesma janela", () => {
      const candidate = profile({
        run: { id: "run-1", exclusive: false, concurrentMeasurements: 1 },
      });

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("concurrent");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("validade", () => {
    it("invalida perfil expirado", () => {
      const candidate = profile({
        measuredAt: new Date(NOW - DEFAULT_PROFILE_TTL_MS - DAY_MS).toISOString(),
      });

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.reasons).toContain("perfil expirado");
    });

    it("respeita validUntil explícito", () => {
      const candidate = profile({ validUntil: new Date(NOW - 1).toISOString() });

      const evaluation = evaluateResourceProfile(candidate, expected(), { now: NOW });

      expect(evaluation.status).toBe("stale");
      expect(evaluation.usable).toBe(false);
    });
  });

  describe("múltiplos projetos", () => {
    it("seleciona somente o perfil mais recente compatível e válido", () => {
      const old = profile({ measuredAt: new Date(NOW - 5 * DAY_MS).toISOString() });
      const newest = profile({ measuredAt: new Date(NOW - DAY_MS).toISOString() });
      const otherProject = profile();
      otherProject.fingerprint.projectId = "proj-outro";
      otherProject.measuredAt = new Date(NOW - 2 * DAY_MS).toISOString();

      const selected = selectLatestCompatibleProfile([old, otherProject, newest], expected(), {
        now: NOW,
      });

      expect(selected).toBe(newest);
    });

    it("não seleciona perfil expirado mesmo sendo o único", () => {
      const expired = profile({
        measuredAt: new Date(NOW - DEFAULT_PROFILE_TTL_MS - DAY_MS).toISOString(),
      });

      const selected = selectLatestCompatibleProfile([expired], expected(), { now: NOW });

      expect(selected).toBeNull();
    });
  });
});
