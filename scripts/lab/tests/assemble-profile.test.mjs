import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleProfile, classifyOutcome, computeInputsFingerprint } from "../lib/assemble-profile.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;
const BASE = `sha256:${"e".repeat(64)}`;

function raw(overrides = {}) {
  return {
    run: { id: "run-mesatta-001", exclusive: true, concurrentMeasurements: 0 },
    measuredAt: "2026-11-25T11:00:00Z",
    imageDigest: DIGEST,
    inputs: {
      projectId: "proj-mesatta",
      commitSha: "commit-abc",
      dockerfileSha256: SHA_A,
      lockfileSha256: SHA_B,
      baseImageId: BASE,
      cacheState: "cold",
      dockerVersion: "27.3.1",
      buildkitVersion: "v0.16.0",
      arch: "x86_64",
      host: {
        memAvailableMb: 4096,
        diskFreeMb: 50000,
        cpuCount: 4,
        cgroupVersion: 2,
        arch: "x86_64",
        dockerVersion: "27.3.1",
        totalMemMb: 8192,
      },
      target: { arch: "x86_64", cgroupVersion: 2, dockerVersion: "27.3.1", totalMemMb: 8192 },
      limits: {
        buildMemoryMb: 1024,
        buildSwapMb: 1024,
        buildCpus: 1,
        stagingMemoryMb: 768,
        stagingSwapMb: 768,
        stagingCpus: 1,
        mongoMemoryMb: 512,
      },
    },
    build: {
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      oomEvents: 0,
      peakMb: 900,
      peakSource: "cgroup-peak",
      samples: 120,
      samplingComplete: true,
      durationMs: 1200000,
      pressureSomePeak: 0.2,
      pressureFullPeak: 0,
    },
    staging: {
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      oomEvents: 0,
      peakMb: 400,
      peakSource: "cgroup-peak",
      samples: 90,
      samplingComplete: true,
      durationMs: 45000,
      pressureSomePeak: 0.1,
      pressureFullPeak: 0,
      healthOk: true,
      bootPeakMb: 380,
      steadyPeakMb: 240,
    },
    ...overrides,
  };
}

test("build bem-sucedido gera perfil de alta confiança sem autorizar redução", () => {
  const profile = assembleProfile(raw());
  assert.equal(profile.confidence, "high");
  assert.equal(profile.lab.buildOutcome, "success");
  assert.equal(profile.lab.stagingOutcome, "success");
  assert.equal(profile.lab.allowedForReservationReduction, false);
  assert.equal(profile.build.peakMb, 900);
  assert.equal(profile.staging.peakMb, 400);
  assert.equal(profile.staging.bootPeakMb, 380);
  assert.equal(profile.staging.steadyPeakMb, 240);
});

test("OOM no build tem prioridade e derruba a confiança", () => {
  const profile = assembleProfile(
    raw({ build: { ...raw().build, exitCode: 137, timedOut: true, oomKilled: true, oomEvents: 1 } }),
  );
  assert.equal(profile.lab.buildOutcome, "oom");
  assert.equal(profile.confidence, "low");
  assert.equal(profile.lab.allowedForReservationReduction, false);
});

test("falha externa não vira OOM nem sucesso", () => {
  const profile = assembleProfile(
    raw({ build: { ...raw().build, exitCode: 1, logTail: "failed to solve: ECONNRESET" } }),
  );
  assert.equal(profile.lab.buildOutcome, "external-failure");
  assert.equal(profile.confidence, "low");
});

test("timeout sem OOM é timeout", () => {
  const profile = assembleProfile(raw({ build: { ...raw().build, exitCode: null, timedOut: true } }));
  assert.equal(classifyOutcome(raw().build).outcome, "success");
  assert.equal(profile.lab.buildOutcome, "timeout");
});

test("falha de medição não é aceita só porque o build terminou", () => {
  const profile = assembleProfile(raw({ build: { ...raw().build, peakMb: null } }));
  assert.equal(profile.lab.buildOutcome, "collection-failure");
  assert.equal(profile.build.complete, false);
});

test("staging com OOM e health reprovado não é sucesso", () => {
  const oom = assembleProfile(raw({ staging: { ...raw().staging, oomKilled: true, oomEvents: 1 } }));
  const unhealthy = assembleProfile(raw({ staging: { ...raw().staging, healthOk: false } }));
  assert.equal(oom.lab.stagingOutcome, "oom");
  assert.equal(unhealthy.lab.stagingOutcome, "external-failure");
});

test("cold e warm são preservados", () => {
  const cold = raw();
  cold.inputs.cacheState = "cold";
  const warm = raw();
  warm.inputs.cacheState = "warm";
  assert.equal(assembleProfile(cold).lab.cacheState, "cold");
  assert.equal(assembleProfile(warm).lab.cacheState, "warm");
});

test("fingerprint dos insumos independe do digest construído", () => {
  const base = raw();
  const other = raw({ imageDigest: `sha256:${"f".repeat(64)}` });
  assert.equal(
    computeInputsFingerprint(base.inputs),
    computeInputsFingerprint(other.inputs),
  );
  assert.notEqual(profileDigest(base), null);
});

function profileDigest(value) {
  return assembleProfile(value).fingerprint.imageDigest;
}

test("ambiente de destino diferente rebaixa para medium", () => {
  const value = raw();
  value.inputs.target.arch = "arm64";
  const profile = assembleProfile(value);
  assert.equal(profile.lab.targetMatches, false);
  assert.equal(profile.confidence, "medium");
});

test("JSON bruto inválido é rejeitado", () => {
  const value = raw();
  value.inputs.dockerfileSha256 = "não-é-sha";
  assert.throws(() => assembleProfile(value), /dockerfileSha256/);
});
