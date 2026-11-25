import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceProfileService,
  type ResourceProfileServiceOptions,
} from "./resource-profile.service";
import {
  RESOURCE_PROFILE_SCHEMA_VERSION,
  type ResourceProfile,
} from "../domain/resource-profile";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;

let dir: string;
let file: string;

function profile(overrides: Partial<ResourceProfile> = {}, projectId = "proj-mesatta"): ResourceProfile {
  return {
    schemaVersion: RESOURCE_PROFILE_SCHEMA_VERSION,
    fingerprint: {
      projectId,
      commitSha: "commit-abc",
      dockerfileSha256: SHA_A,
      lockfileSha256: SHA_B,
      imageDigest: DIGEST,
      buildMemoryLimitMb: 1024,
      stagingMemoryLimitMb: 768,
    },
    measuredAt: new Date(NOW - 60_000).toISOString(),
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
      stepPeaks: [],
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
    notes: [],
    ...overrides,
  };
}

function service(options: ResourceProfileServiceOptions = {}): ResourceProfileService {
  const instance = new ResourceProfileService({
    filePath: file,
    now: () => NOW,
    ...options,
  });
  instance.onModuleInit();
  return instance;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "korrelo-profiles-"));
  file = join(dir, "resource-profiles.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ResourceProfileService", () => {
  it("perfil ausente continua ausente e informa explicitamente", () => {
    const panel = service().describe("proj-mesatta");

    expect(panel.profiles).toEqual([]);
    expect(panel.latestMeasurement).toBeNull();
    expect(panel.latestValid).toBeNull();
    expect(panel.message).toBe("Perfil de build ainda não medido.");
    expect(existsSync(file)).toBe(false);
  });

  it("persiste perfil válido com escrita atômica e modo restrito", () => {
    const store = service();
    const result = store.save(profile());

    expect(result.saved).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.schemaVersion).toBe(RESOURCE_PROFILE_SCHEMA_VERSION);
    expect(parsed.profiles).toHaveLength(1);
  });

  it("sobrevive a restart carregando o mesmo arquivo", () => {
    service().save(profile());

    const restarted = service();
    const panel = restarted.describe("proj-mesatta");

    expect(panel.profiles).toHaveLength(1);
    expect(panel.latestValid?.buildPeakMb).toBe(900);
    expect(panel.latestValid?.stagingPeakMb).toBe(400);
    expect(panel.latestValid?.confidence).toBe("high");
    expect(panel.message).toBeNull();
  });

  it("arquivo corrompido não derruba o serviço e não é apagado", () => {
    writeFileSync(file, "{ isto não é json", "utf8");

    const store = service();

    expect(store.describe("proj-mesatta").message).toBe("Perfil de build ainda não medido.");
    expect(readFileSync(file, "utf8")).toBe("{ isto não é json");
  });

  it("rejeita perfil inválido sem criar arquivo", () => {
    const store = service();
    const invalid = profile();
    invalid.fingerprint.dockerfileSha256 = "não-é-sha";

    const result = store.save(invalid);

    expect(result.saved).toBe(false);
    expect(result.reason).toContain("perfil inválido");
    expect(existsSync(file)).toBe(false);
  });

  it("separa projetos e não vaza perfil de outro projeto", () => {
    const store = service();
    store.save(profile());

    expect(store.describe("proj-outro").profiles).toEqual([]);
    expect(store.describe("proj-outro").message).toBe("Perfil de build ainda não medido.");
    expect(store.list("proj-outro")).toEqual([]);
  });

  it("perfil expirado aparece como stale e não utilizável", () => {
    const store = service();
    store.save(
      profile({ measuredAt: new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString() }),
    );

    const panel = store.describe("proj-mesatta");

    expect(panel.latestMeasurement?.status).toBe("stale");
    expect(panel.latestMeasurement?.usable).toBe(false);
    expect(panel.latestMeasurement?.reasons).toContain("perfil expirado");
    expect(panel.message).toBe("Nenhuma medição válida disponível para este projeto.");
  });

  it("OOM marca unsafe e não vira última medição válida", () => {
    const store = service();
    const oom = profile();
    oom.build.oomKilled = true;
    oom.build.oomEvents = 1;
    store.save(oom);

    const panel = store.describe("proj-mesatta");

    expect(panel.latestMeasurement?.status).toBe("unsafe");
    expect(panel.latestMeasurement?.usable).toBe(false);
    expect(panel.latestValid).toBeNull();
  });

  it("medição incompleta não é aceita", () => {
    const store = service();
    const incomplete = profile();
    incomplete.staging.complete = false;
    incomplete.staging.peakMb = null;
    store.save(incomplete);

    expect(store.describe("proj-mesatta").latestMeasurement?.status).toBe("incomplete");
  });

  it("ignora arquivo temporário de escrita interrompida", () => {
    writeFileSync(`${file}.tmp`, "lixo", "utf8");

    const store = service();
    expect(store.size()).toBe(0);

    expect(store.save(profile()).saved).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("mantém JSON válido sob gravações concorrentes", async () => {
    const store = service();

    const results = await Promise.all([
      Promise.resolve(store.save(profile({ measuredAt: new Date(NOW - 30_000).toISOString() }))),
      Promise.resolve(store.save(profile({ measuredAt: new Date(NOW - 20_000).toISOString() }))),
      Promise.resolve(store.save(profile({ measuredAt: new Date(NOW - 10_000).toISOString() }))),
    ]);

    expect(results.every((result) => result.saved)).toBe(true);
    expect(store.describe("proj-mesatta").profiles).toHaveLength(3);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("aplica limite total e por projeto", () => {
    const store = service({ maxProfiles: 2, maxPerProject: 1 });
    store.save(profile({ measuredAt: new Date(NOW - 20_000).toISOString() }));
    store.save(profile({ measuredAt: new Date(NOW - 10_000).toISOString() }));
    store.save(profile({ measuredAt: new Date(NOW - 5_000).toISOString() }, "proj-outro"));

    const mesatta = store.describe("proj-mesatta");
    expect(mesatta.profiles).toHaveLength(1);
    expect(mesatta.profiles[0].measuredAt).toBe(new Date(NOW - 10_000).toISOString());
  });

  it("rejeita envelope com schema desconhecido", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 99, profiles: [profile()] }),
      "utf8",
    );

    expect(service().size()).toBe(0);
  });

  it("importa relatórios válidos do laboratório e ignora lixo", () => {
    const reports = join(dir, "lab", "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, "run-ok.json"), JSON.stringify(profile()), "utf8");
    writeFileSync(join(reports, "run-bad.json"), "{ corrompido", "utf8");
    writeFileSync(
      join(reports, "raw.json"),
      JSON.stringify({ inputs: {}, build: {}, staging: {} }),
      "utf8",
    );

    const store = service();
    const panel = store.describe("proj-mesatta");

    expect(panel.profiles).toHaveLength(1);
    expect(panel.latestValid?.buildPeakMb).toBe(900);
    expect(existsSync(file)).toBe(true);
  });

  it("não cria store quando não há relatório válido", () => {
    const reports = join(dir, "lab", "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, "run-bad.json"), "{ corrompido", "utf8");

    const store = service();

    expect(store.size()).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("falha de escrita é reportada sem derrubar o serviço", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "arquivo no lugar de diretório", "utf8");
    const broken = new ResourceProfileService({
      filePath: join(blocker, "resource-profiles.json"),
      now: () => NOW,
    });
    broken.onModuleInit();

    const result = broken.save(profile());

    expect(result.saved).toBe(false);
    expect(result.reason).toBe("falha ao persistir");
    expect(broken.describe("proj-mesatta").profiles).toEqual([]);
  });

  it("arquivo acima do limite é ignorado sem apagar", () => {
    writeFileSync(file, "x".repeat(2048), "utf8");
    const store = service({ maxFileBytes: 1024 });

    expect(store.size()).toBe(0);
    expect(readFileSync(file, "utf8")).toHaveLength(2048);
  });

  it("não altera o perfil original ao montar o resumo", () => {
    const store = service();
    const original = profile();
    store.save(original);
    const before = JSON.stringify(original);
    store.describe("proj-mesatta");

    expect(JSON.stringify(original)).toBe(before);
  });

  it("modo 0600 é tentado mesmo quando o arquivo já existe", () => {
    if (process.platform === "win32") return;
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, profiles: [] }), "utf8");
    chmodSync(file, 0o644);

    service().save(profile());

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
