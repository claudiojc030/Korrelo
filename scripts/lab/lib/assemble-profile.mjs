#!/usr/bin/env node
/**
 * Monta o relatório final de laboratório no formato `ResourceProfile`
 * (Fase C.3a) a partir do JSON bruto produzido por
 * `scripts/lab/measure-project-profile.sh`.
 *
 * Este arquivo é JavaScript puro de propósito: o laboratório roda fora do
 * build da API e não deve depender de ts-node/tsx. A lógica espelha
 * `apps/api/src/modules/projects/domain/resource-lab.ts`; os testes dos dois
 * lados usam os mesmos cenários.
 *
 * NUNCA autoriza reduzir reservas: `allowedForReservationReduction` é sempre
 * false. O perfil é evidência, não decisão.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const SCHEMA_VERSION = 1;

const EXTERNAL_FAILURE_PATTERNS = [
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /eai_again/i,
  /no such host/i,
  /could not resolve/i,
  /tls handshake timeout/i,
  /failed to fetch/i,
  /failed to download/i,
  /registry.*(?:unavailable|timeout)/i,
  /network is unreachable/i,
  /\b(?:429|502|503|504)\b/,
];

const OOM_PATTERNS = [
  /out of memory/i,
  /cannot allocate memory/i,
  /\benomem\b/i,
  /killed\s*$/im,
  /signal:\s*killed/i,
  /exit code:\s*137/i,
];

function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      output[key] = normalize(value[key]);
    }
    return output;
  }
  return value;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isImageDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function computeInputsFingerprint(inputs) {
  return createHash("sha256")
    .update(
      canonicalize({
        projectId: inputs.projectId,
        commitSha: inputs.commitSha,
        dockerfileSha256: inputs.dockerfileSha256,
        lockfileSha256: inputs.lockfileSha256,
        baseImageId: inputs.baseImageId,
        cacheState: inputs.cacheState,
        dockerVersion: inputs.dockerVersion,
        buildkitVersion: inputs.buildkitVersion,
        arch: inputs.arch,
        limits: inputs.limits,
        target: inputs.target,
      }),
      "utf-8",
    )
    .digest("hex");
}

export function classifyOutcome(raw, { requireHealth = false } = {}) {
  const log = `${raw?.logTail ?? ""}\n${raw?.errorMessage ?? ""}`;
  const reasons = [];
  const oomByCgroup = raw?.oomKilled === true || (raw?.oomEvents ?? 0) > 0;
  const oomByExit = raw?.exitCode === 137 && raw?.timedOut !== true;
  const oomByLog = OOM_PATTERNS.some((pattern) => pattern.test(log));

  if (oomByCgroup || oomByExit || oomByLog) {
    if (oomByCgroup) reasons.push("cgroup reportou OOM");
    if (oomByExit) reasons.push("exit code 137 (SIGKILL)");
    if (oomByLog) reasons.push("log contém sinal de falta de memória");
    return { outcome: "oom", reasons };
  }
  if (raw?.timedOut === true) {
    return { outcome: "timeout", reasons: ["tempo máximo excedido"] };
  }
  if (raw?.exitCode === null || raw?.exitCode === undefined) {
    return { outcome: "incomplete", reasons: ["processo não retornou código de saída"] };
  }
  if (raw.exitCode === 0) {
    if (!raw.samples || raw.peakMb === null) {
      return { outcome: "collection-failure", reasons: ["memória não foi medida"] };
    }
    if (!raw.samplingComplete) {
      return { outcome: "collection-failure", reasons: ["amostragem de memória incompleta"] };
    }
    if (requireHealth && raw.healthOk !== true) {
      return { outcome: "external-failure", reasons: ["healthcheck não passou"] };
    }
    return { outcome: "success", reasons: [] };
  }
  if (EXTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(log))) {
    return { outcome: "external-failure", reasons: ["falha de rede/registro/dependência externa"] };
  }
  return {
    outcome: "external-failure",
    reasons: [`falhou com exit code ${raw.exitCode} sem evidência de OOM`],
  };
}

function targetReasons(host, target) {
  const reasons = [];
  if (!host?.arch || !target?.arch || host.arch !== target.arch) {
    reasons.push(`arquitetura diferente (lab=${host?.arch ?? "?"}, destino=${target?.arch ?? "?"})`);
  }
  if (host?.cgroupVersion !== target?.cgroupVersion) {
    reasons.push(
      `cgroup diferente (lab=v${host?.cgroupVersion ?? "?"}, destino=v${target?.cgroupVersion ?? "?"})`,
    );
  }
  const labMajor = dockerMajor(host?.dockerVersion);
  const targetMajor = dockerMajor(target?.dockerVersion);
  if (labMajor !== null && targetMajor !== null && labMajor !== targetMajor) {
    reasons.push(`Docker major diferente (lab=${labMajor}, destino=${targetMajor})`);
  }
  if (
    typeof host?.totalMemMb === "number" &&
    host.totalMemMb > 0 &&
    typeof target?.totalMemMb === "number" &&
    target.totalMemMb > 0
  ) {
    const ratio = target.totalMemMb / host.totalMemMb;
    if (ratio < 0.5 || ratio > 2) {
      reasons.push(
        `RAM do destino (${target.totalMemMb} MB) muito diferente do laboratório (${host.totalMemMb} MB)`,
      );
    }
  }
  return reasons;
}

function dockerMajor(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

function baseConfidence(profile) {
  const build = profile.build;
  const staging = profile.staging;
  if (
    !build?.complete ||
    !staging?.complete ||
    build.peakMb === null ||
    staging.peakMb === null ||
    build.oomKilled ||
    staging.oomKilled ||
    build.oomEvents > 0 ||
    staging.oomEvents > 0
  ) {
    return "low";
  }
  const strong =
    profile.environment === "lab" &&
    profile.run.exclusive === true &&
    profile.run.concurrentMeasurements === 0 &&
    build.limitEnforced === true &&
    build.psiSomePeak !== null &&
    build.psiFullPeak !== null &&
    staging.psiSomePeak !== null &&
    staging.psiFullPeak !== null &&
    staging.healthOk === true &&
    isImageDigest(profile.fingerprint.imageDigest);
  return strong ? "high" : "medium";
}

/**
 * @param {object} raw JSON bruto do harness.
 * @returns {object} perfil compatível com ResourceProfile + bloco `lab`.
 */
export function assembleProfile(raw) {
  const inputs = raw.inputs ?? {};
  const buildRaw = raw.build ?? {};
  const stagingRaw = raw.staging ?? {};

  if (!isSha256(inputs.dockerfileSha256)) {
    throw new Error("dockerfileSha256 inválido no JSON bruto");
  }
  if (!positiveInteger(inputs.limits?.buildMemoryMb) || !positiveInteger(inputs.limits?.stagingMemoryMb)) {
    throw new Error("limites ausentes no JSON bruto");
  }

  const buildOutcome = classifyOutcome(buildRaw);
  const stagingOutcome = classifyOutcome(stagingRaw, { requireHealth: true });
  const mismatch = targetReasons(inputs.host, inputs.target);
  const imageDigest = typeof raw.imageDigest === "string" ? raw.imageDigest : null;

  const buildPeak = positiveInteger(buildRaw.peakMb) ? buildRaw.peakMb : null;
  const stagingPeak = positiveInteger(stagingRaw.peakMb) ? stagingRaw.peakMb : null;
  const bootPeak = positiveInteger(stagingRaw.bootPeakMb) ? stagingRaw.bootPeakMb : stagingPeak;
  const steadyPeak = positiveInteger(stagingRaw.steadyPeakMb) ? stagingRaw.steadyPeakMb : null;

  const notes = [
    ...(Array.isArray(raw.notes) ? raw.notes : []),
    `cache=${inputs.cacheState}`,
    `buildOutcome=${buildOutcome.outcome}`,
    `stagingOutcome=${stagingOutcome.outcome}`,
    ...buildOutcome.reasons.map((reason) => `build: ${reason}`),
    ...stagingOutcome.reasons.map((reason) => `staging: ${reason}`),
    ...mismatch.map((reason) => `destino: ${reason}`),
    "perfil de laboratório; não autoriza reduzir reservas nesta fase",
  ];

  const profile = {
    schemaVersion: SCHEMA_VERSION,
    fingerprint: {
      projectId: inputs.projectId,
      commitSha: inputs.commitSha,
      dockerfileSha256: inputs.dockerfileSha256,
      lockfileSha256: inputs.lockfileSha256 ?? null,
      imageDigest,
      buildMemoryLimitMb: inputs.limits.buildMemoryMb,
      stagingMemoryLimitMb: inputs.limits.stagingMemoryMb,
    },
    measuredAt: raw.measuredAt,
    validUntil: null,
    environment: "lab",
    run: {
      id: raw.run?.id ?? "unknown",
      exclusive: raw.run?.exclusive === true,
      concurrentMeasurements: Number(raw.run?.concurrentMeasurements ?? 0),
    },
    build: {
      memoryLimitMb: inputs.limits.buildMemoryMb,
      limitEnforced: true,
      peakMb: buildPeak,
      oomKilled: buildRaw.oomKilled === true,
      oomEvents: Number(buildRaw.oomEvents ?? 0),
      psiSomePeak: numberOrNull(buildRaw.pressureSomePeak),
      psiFullPeak: numberOrNull(buildRaw.pressureFullPeak),
      durationMs: numberOrNull(buildRaw.durationMs),
      complete: buildOutcome.outcome === "success" || buildOutcome.outcome === "oom",
      stepPeaks: Array.isArray(buildRaw.stepPeaks) ? buildRaw.stepPeaks : [],
    },
    staging: {
      memoryLimitMb: inputs.limits.stagingMemoryMb,
      bootPeakMb: bootPeak,
      steadyPeakMb: steadyPeak,
      peakMb: stagingPeak,
      oomKilled: stagingRaw.oomKilled === true,
      oomEvents: Number(stagingRaw.oomEvents ?? 0),
      psiSomePeak: numberOrNull(stagingRaw.pressureSomePeak),
      psiFullPeak: numberOrNull(stagingRaw.pressureFullPeak),
      healthOk: stagingRaw.healthOk === true,
      bootDurationMs: numberOrNull(stagingRaw.durationMs),
      complete: stagingOutcome.outcome === "success" || stagingOutcome.outcome === "oom",
    },
    confidence: "low",
    notes,
    lab: {
      dockerVersion: inputs.dockerVersion ?? null,
      buildkitVersion: inputs.buildkitVersion ?? null,
      arch: inputs.arch ?? null,
      cacheState: inputs.cacheState ?? "unknown",
      baseImageId: inputs.baseImageId ?? null,
      imageDigest,
      host: inputs.host ?? {},
      target: inputs.target ?? {},
      buildOutcome: buildOutcome.outcome,
      stagingOutcome: stagingOutcome.outcome,
      inputsFingerprint: computeInputsFingerprint(inputs),
      targetMatches: mismatch.length === 0,
      targetMismatchReasons: mismatch,
      exclusive: raw.run?.exclusive === true,
      allowedForReservationReduction: false,
      notes,
    },
  };

  const base = baseConfidence(profile);
  const confident =
    base === "low"
      ? "low"
      : buildOutcome.outcome !== "success" ||
          stagingOutcome.outcome !== "success" ||
          mismatch.length > 0 ||
          inputs.cacheState === "unknown" ||
          !isImageDigest(imageDigest)
        ? "medium"
        : base;
  profile.confidence = confident;

  return profile;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.raw || !args.out) {
    console.error("uso: assemble-profile.mjs --raw <raw.json> --out <report.json>");
    process.exit(2);
  }
  const raw = JSON.parse(await readFile(args.raw, "utf8"));
  const profile = assembleProfile(raw);
  await writeFile(args.out, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`[lab] relatório: ${args.out}`);
  console.log(
    `[lab] build=${profile.lab.buildOutcome} staging=${profile.lab.stagingOutcome} ` +
      `confiança=${profile.confidence} (não autoriza reduzir reservas)`,
  );
  return 0;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--raw") result.raw = argv[++index];
    else if (item === "--out") result.out = argv[++index];
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("assemble-profile.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[lab] falha ao montar relatório: ${error.message}`);
      process.exit(1);
    },
  );
}
