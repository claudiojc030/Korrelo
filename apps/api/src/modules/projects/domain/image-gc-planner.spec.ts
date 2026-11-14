import {
  normalizeImageGcMode,
  planImageGc,
  type ImageGcInput,
} from "./image-gc-planner";

const IMAGE = "korrelo-mesatta-8452004c";
const prod = `${IMAGE}:commit-b162880a5c14`;
const rollback = `${IMAGE}:commit-58d1db22f9a2`;
const failed = `${IMAGE}:commit-e1f001b94ccd`;
const old1 = `${IMAGE}:commit-111111111111`;
const old2 = `${IMAGE}:commit-222222222222`;
const old3 = `${IMAGE}:commit-333333333333`;

function input(overrides: Partial<ImageGcInput> = {}): ImageGcInput {
  return {
    imageName: IMAGE,
    images: [],
    containers: [],
    projects: [{ projectId: "p1", currentImage: prod, previousImage: rollback }],
    databaseOk: true,
    dockerOk: true,
    mode: "dry-run",
    retentionExtra: 3,
    ...overrides,
  };
}

function decision(plan: ReturnType<typeof planImageGc>, reference: string) {
  return plan.decisions.find((entry) => entry.reference === reference);
}

describe("image GC planner (dry-run)", () => {
  it("protege a imagem de produção", () => {
    const plan = planImageGc(
      input({ images: [{ reference: prod, id: "sha256:aaa", createdAt: "2026-11-01" }] }),
    );
    expect(decision(plan, prod)?.decision).toBe("KEEP");
    expect(decision(plan, prod)?.reasons.join(" ")).toContain("protegida");
  });

  it("protege a imagem de rollback", () => {
    const plan = planImageGc(
      input({ images: [{ reference: rollback, id: "sha256:bbb", createdAt: "2026-10-30" }] }),
    );
    expect(decision(plan, rollback)?.decision).toBe("KEEP");
  });

  it("container PARADO também protege a imagem", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1" }],
        images: [{ reference: old1, id: "sha256:ccc", createdAt: "2026-10-01" }],
        containers: [
          { name: "korrelo-mesatta-8452004c-staging", imageReference: old1, imageId: "sha256:ccc", state: "exited" },
        ],
      }),
    );
    expect(decision(plan, old1)?.decision).toBe("KEEP");
    expect(decision(plan, old1)?.reasons.join(" ")).toContain("protegida");
  });

  it("duas tags do mesmo ID: ambas protegidas", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1", currentImage: prod }],
        images: [
          { reference: prod, id: "sha256:same", createdAt: "2026-11-01" },
          { reference: rollback, id: "sha256:same", createdAt: "2026-10-01" },
        ],
      }),
    );
    expect(decision(plan, prod)?.decision).toBe("KEEP");
    expect(decision(plan, rollback)?.decision).toBe("KEEP");
  });

  it("job ativo protege sua candidata", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1" }],
        activeJobImages: [failed],
        images: [{ reference: failed, id: "sha256:ddd", createdAt: "2026-11-10" }],
      }),
    );
    expect(decision(plan, failed)?.decision).toBe("KEEP");
  });

  it("staging reprovado sem referências é candidato quando a retenção simulada é 0", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1" }],
        retentionExtra: 0,
        images: [{ reference: failed, id: "sha256:eee", createdAt: "2026-11-10" }],
      }),
    );
    expect(decision(plan, failed)?.decision).toBe("CANDIDATE");
  });

  it("com a política atual (3 extras) a reprovada mais nova fica retida", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1" }],
        images: [{ reference: failed, id: "sha256:eee", createdAt: "2026-11-10" }],
      }),
    );
    expect(decision(plan, failed)?.decision).toBe("KEEP");
    expect(decision(plan, failed)?.reasons.join(" ")).toContain("retenção atual");
  });

  it("compose estável/temporário protege a referência", () => {
    const plan = planImageGc(
      input({
        projects: [
          { projectId: "p1", composeReferences: [old2] },
        ],
        images: [{ reference: old2, id: "sha256:fff", createdAt: "2026-09-01" }],
      }),
    );
    expect(decision(plan, old2)?.decision).toBe("KEEP");
  });

  it("docker inspect falhou: UNKNOWN, nunca CANDIDATE", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1" }],
        retentionExtra: 0,
        unverifiedReferences: [old3],
        images: [{ reference: old3, id: "sha256:999", createdAt: "2026-09-01" }],
      }),
    );
    expect(decision(plan, old3)?.decision).toBe("UNKNOWN");
  });

  it("falha na leitura do banco: tudo UNKNOWN", () => {
    const plan = planImageGc(
      input({
        databaseOk: false,
        images: [
          { reference: prod, id: "sha256:aaa", createdAt: "2026-11-01" },
          { reference: old1, id: "sha256:111", createdAt: "2026-08-01" },
        ],
      }),
    );
    expect(plan.decisions.every((entry) => entry.decision === "UNKNOWN")).toBe(true);
  });

  it("Docker indisponível: tudo UNKNOWN", () => {
    const plan = planImageGc(
      input({
        dockerOk: false,
        images: [{ reference: old1, id: "sha256:111", createdAt: "2026-08-01" }],
      }),
    );
    expect(decision(plan, old1)?.decision).toBe("UNKNOWN");
  });

  it("concorrência: candidata de job ativo nunca vira CANDIDATE; antigas continuam candidatas", () => {
    const plan = planImageGc(
      input({
        projects: [{ projectId: "p1", currentImage: prod, previousImage: rollback }],
        activeJobImages: [failed],
        retentionExtra: 0,
        images: [
          { reference: prod, id: "sha256:aaa", createdAt: "2026-11-01" },
          { reference: rollback, id: "sha256:bbb", createdAt: "2026-10-20" },
          { reference: failed, id: "sha256:ccc", createdAt: "2026-11-12" },
          { reference: old1, id: "sha256:111", createdAt: "2026-09-01" },
          { reference: old2, id: "sha256:222", createdAt: "2026-08-01" },
        ],
      }),
    );
    expect(decision(plan, failed)?.decision).toBe("KEEP");
    expect(decision(plan, old1)?.decision).toBe("CANDIDATE");
    expect(decision(plan, old2)?.decision).toBe("CANDIDATE");
  });

  it("modo off não avalia nada", () => {
    const plan = planImageGc(input({ mode: "off", images: [{ reference: old1, id: "sha256:1", createdAt: "" }] }));
    expect(plan.decisions).toHaveLength(0);
    expect(plan.summary.skipped).toBe(true);
  });

  it("apply é rebaixado para dry-run (nunca aplica nesta fase)", () => {
    expect(normalizeImageGcMode("apply")).toEqual({ mode: "dry-run", downgraded: true });
    expect(normalizeImageGcMode("off")).toEqual({ mode: "off", downgraded: false });
    expect(normalizeImageGcMode(undefined)).toEqual({ mode: "dry-run", downgraded: false });
  });
});
