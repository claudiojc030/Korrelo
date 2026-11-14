import { ImageGcAuditService } from "./image-gc-audit.service";

/**
 * DRY-RUN: o serviço só pode emitir comandos de LEITURA.
 * Nenhuma chamada a rmi/prune/rm/stop/compose é permitida.
 */
describe("ImageGcAuditService (dry-run)", () => {
  const IMAGE = "korrelo-mesatta-8452004c";
  const prod = `${IMAGE}:commit-b162880a5c14`;
  const rollback = `${IMAGE}:commit-58d1db22f9a2`;
  const failed = `${IMAGE}:commit-e1f001b94ccd`;
  const old = `${IMAGE}:commit-111111111111`;

  function harness(options: { dockerOk?: boolean } = {}) {
    const calls: { command: string; args: string[] }[] = [];
    const runner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      const result = (stdout = "", exitCode = 0) => ({
        stdout,
        stderr: "",
        exitCode,
        timedOut: false,
      });
      if (options.dockerOk === false) return { ...result("", 1), stderr: "daemon down" };
      if (args[0] === "images") {
        return result(
          [
            `${prod}\tsha256:aaa\t2026-11-01`,
            `${rollback}\tsha256:bbb\t2026-10-20`,
            `${failed}\tsha256:ccc\t2026-11-12`,
            `${old}\tsha256:111\t2026-08-01`,
          ].join("\n") + "\n",
        );
      }
      if (args[0] === "ps") {
        return result("korrelo-mesatta-8452004c\t" + prod + "\trunning\n");
      }
      if (args[0] === "inspect") return result("sha256:aaa\n");
      return result("");
    };

    const projects = {
      findAll: async () => [
        { id: "p1", currentImage: prod, previousImage: rollback },
      ],
    };
    const jobs = {
      findAllByStatus: async () => [],
    };
    const service = new ImageGcAuditService(
      projects as any,
      jobs as any,
      runner as any,
    );
    return { service, calls };
  }

  afterEach(() => {
    delete process.env.KORRELO_IMAGE_GC_MODE;
    delete process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA;
  });

  it("não executa nenhuma operação destrutiva e mantém produção/rollback", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const { service, calls } = harness();

    const plan = await service.audit();

    const destructive = calls.filter((call) =>
      ["rmi", "prune", "rm", "stop", "start", "restart", "up", "down", "compose"].includes(
        call.args[0],
      ),
    );
    expect(destructive).toEqual([]);
    // Só leitura.
    expect(calls.every((call) => call.command === "docker")).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(
      expect.arrayContaining(["images", "ps", "inspect"]),
    );

    const byRef = new Map(plan.decisions.map((d) => [d.reference, d.decision]));
    expect(byRef.get(prod)).toBe("KEEP");
    expect(byRef.get(rollback)).toBe("KEEP");
    // Com retenção simulada 0, a candidata reprovada é CANDIDATE.
    expect(byRef.get(failed)).toBe("CANDIDATE");
    expect(byRef.get(old)).toBe("CANDIDATE");
    expect(plan.mode).toBe("dry-run");
  });

  it("política atual (rollout inicial) mantém 3 imagens extras", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    const { service } = harness();

    const plan = await service.audit();
    const byRef = new Map(plan.decisions.map((d) => [d.reference, d.decision]));
    expect(byRef.get(failed)).toBe("KEEP");
    expect(byRef.get(old)).toBe("KEEP");
  });

  it("Docker indisponível: plano UNKNOWN, sem qualquer remoção", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    const { service, calls } = harness({ dockerOk: false });

    const plan = await service.audit();

    expect(plan.decisions.every((d) => d.decision === "UNKNOWN")).toBe(true);
    expect(calls.some((call) => ["rmi", "prune", "rm"].includes(call.args[0]))).toBe(false);
  });

  it("KORRELO_IMAGE_GC_MODE=off não coleta nem decide", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "off";
    const { service, calls } = harness();

    const plan = await service.audit();

    expect(plan.summary.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("redução para 1 exige configuração explícita", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "1";
    const { service } = harness();

    const plan = await service.audit();
    const byRef = new Map(plan.decisions.map((d) => [d.reference, d.decision]));
    expect(byRef.get(failed)).toBe("KEEP");
    expect(byRef.get(old)).toBe("CANDIDATE");
  });

  it("auditorias concorrentes: a segunda é descartada (skipped)", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = async (command: string, args: string[]) => {
      if (args[0] === "images") {
        await gate;
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const first = service.audit();
    await new Promise((resolve) => setImmediate(resolve));
    const second = await service.audit();
    expect(second.summary.skipped).toBe(true);

    release();
    await first;
  });

  it("imagens externas (mongo/app:latest) nunca entram no plano", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") {
        return { stdout: [`${prod}\tsha256:aaa\t2026-11-01`, "mongo:7\tsha256:ext1\t2026-01-01", "app:latest\tsha256:ext2\t2026-01-01"].join("\n") + "\n", stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "ps") return { stdout: "korrelo-mesatta-8452004c\t" + prod + "\trunning\n", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:aaa\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod, previousImage: rollback }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    const refs = plan.decisions.map((decision) => decision.reference);
    expect(refs).not.toContain("mongo:7");
    expect(refs).not.toContain("app:latest");
    expect(refs).toContain(prod);
  });

  it("projeto gerenciado com currentImage nulo entra via containerName", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    const evolution = "korrelo-evolution-1234abcd:commit-eee";
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") return { stdout: `${evolution}\tsha256:evo\t2026-11-01\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:evo\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p2", containerName: "korrelo-evolution-1234abcd", currentImage: null, previousImage: null }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    expect(plan.decisions.map((d) => d.reference)).toContain(evolution);
  });

  it("apply remove SOMENTE tags candidatas com docker image rm", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const rmCalls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") {
        return { stdout: [
          `${prod}\tsha256:aaa\t2026-11-01`,
          `${rollback}\tsha256:bbb\t2026-10-20`,
          `${failed}\tsha256:ccc\t2026-11-12`,
          `${old}\tsha256:111\t2026-08-01`,
        ].join("\n") + "\n", stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "ps") return { stdout: `korrelo-mesatta-8452004c\t${prod}\trunning\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:aaa\n", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "image" && args[1] === "inspect") {
        const ref = args[args.length - 1];
        const ids: Record<string, string> = { [prod]: "sha256:aaa", [rollback]: "sha256:bbb", [failed]: "sha256:ccc", [old]: "sha256:111" };
        return { stdout: `${ids[ref] ?? ""}\n`, stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "image" && args[1] === "rm") {
        rmCalls.push(args);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "system") return { stdout: "Images=1GB Containers=0B\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod, previousImage: rollback }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();

    expect(rmCalls.every((args) => args[0] === "image" && args[1] === "rm")).toBe(true);
    expect(rmCalls.every((args) => args.length === 3 && !args.includes("-f"))).toBe(true);
    expect(rmCalls.map((args) => args[2])).toEqual(expect.arrayContaining([failed, old]));
    expect(plan.applied?.removed).toEqual(expect.arrayContaining([failed, old]));
  });

  it("apply não remove quando a identidade muda entre planejamento e remoção", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const rmCalls: string[] = [];
    let inspectCount = 0;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") return { stdout: `${failed}\tsha256:planned\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "image" && args[1] === "inspect") {
        inspectCount += 1;
        return { stdout: `sha256:${inspectCount === 1 ? "changed" : "changed2"}\n`, stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "image" && args[1] === "rm") {
        rmCalls.push(args[2]);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: "korrelo-mesatta-8452004c:commit-prod" }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    expect(rmCalls).toHaveLength(0);
    expect(plan.applied?.skipped).toContain(failed);
  });

  it("audit({readOnly:true}) nunca remove, mesmo com env apply", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return { stdout: `${failed}\tsha256:ccc\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:ccc\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit({ readOnly: true });

    expect(plan.mode).toBe("dry-run");
    expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  it("projeto sem currentImage: imagens ficam UNKNOWN e apply não remove", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const evolutionRef = "korrelo-evolution-1234abcd:commit-e1f001b94ccd";
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return { stdout: `${evolutionRef}\tsha256:ccc\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:ccc\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-evolution-1234abcd", currentImage: null }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    expect(plan.decisions.find((d) => d.reference === evolutionRef)?.decision).toBe("UNKNOWN");
    expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  it("mais de 50 containers: inventário truncado bloqueia apply", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const calls: string[][] = [];
    const psLines = Array.from({ length: 51 }, (_, i) => `korrelo-mesatta-8452004c-${i}\t${prod}\trunning`).join("\n") + "\n";
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return { stdout: `${failed}\tsha256:ccc\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: psLines, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:aaa\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    expect(plan.decisions.every((d) => d.decision === "UNKNOWN")).toBe(true);
    expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  it("Compose ilegível/malformado bloqueia apply e marca UNKNOWN", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return { stdout: `${failed}\tsha256:ccc\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:ccc\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );
    (service as any).readComposeReferences = async () => ({
      references: [],
      error: "docker-compose.korrelo.yml malformado",
    });

    const plan = await service.audit();
    expect(plan.decisions.every((d) => d.decision === "UNKNOWN")).toBe(true);
    expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  it("docker image rm recusado não lança e fica como skipped", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") return { stdout: `${failed}\tsha256:ccc\t2026-11-12\n`, stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:ccc\n", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "image" && args[1] === "rm") return { stdout: "", stderr: "image is being used", exitCode: 1, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-mesatta-8452004c", currentImage: prod }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    expect(plan.applied?.removed).toHaveLength(0);
    expect(plan.applied?.skipped).toContain(failed);
  });

  it("inventário real com 7 imagens (inclui -app/-app_staging) é representado sem candidatos perigosos", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "dry-run";
    const mesatta = "korrelo-mesatta-8452004c";
    const evolution = "korrelo-evolution-api-whatsapp-f848a858";
    const mesattaProd = `${mesatta}:commit-b162880a5c14`;
    const mesattaRollback = `${mesatta}:commit-58d1db22f9a2`;
    const mesattaOld = `${mesatta}:commit-af66af14684e`;
    const mesattaApp = `${mesatta}-app:latest`;
    const mesattaStaging = `${mesatta}-app_staging:latest`;
    const evolutionApp = `${evolution}-app:latest`;
    const evolutionStaging = `${evolution}-app_staging:latest`;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "images") {
        return {
          stdout: [
            `${mesattaProd}\tsha256:mprod\t2026-11-01`,
            `${mesattaRollback}\tsha256:mroll\t2026-10-20`,
            `${mesattaOld}\tsha256:mold\t2026-09-01`,
            `${mesattaApp}\tsha256:mapp\t2026-08-01`,
            `${mesattaStaging}\tsha256:mstg\t2026-08-01`,
            `${evolutionApp}\tsha256:2273c1dc\t2026-08-01`,
            `${evolutionStaging}\tsha256:12028e2a\t2026-08-01`,
          ].join("\n") + "\n",
          stderr: "", exitCode: 0, timedOut: false,
        };
      }
      if (args[0] === "ps") {
        return {
          stdout:
            `korrelo-mesatta-8452004c\t${mesattaProd}\trunning\n` +
            `korrelo-evolution-api-whatsapp-f848a858\t${evolution}-app\trunning\n`,
          stderr: "", exitCode: 0, timedOut: false,
        };
      }
      if (args[0] === "inspect") {
        const name = args[args.length - 1];
        return {
          stdout: `${name.includes("evolution") ? "sha256:2273c1dc" : "sha256:mprod"}\n`,
          stderr: "", exitCode: 0, timedOut: false,
        };
      }
      if (args[0] === "system") return { stdout: "Images=1GB\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      {
        findAll: async () => [
          { id: "p1", containerName: mesatta, currentImage: mesattaProd, previousImage: mesattaRollback },
          { id: "p2", containerName: evolution, currentImage: null, previousImage: null },
        ],
      } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );

    const plan = await service.audit();
    const byRef = new Map(plan.decisions.map((d) => [d.reference, d.decision]));

    // Todas as 7 imagens gerenciadas ficam representadas.
    expect(plan.decisions).toHaveLength(7);
    expect(byRef.get(mesattaProd)).toBe("KEEP");
    expect(byRef.get(mesattaRollback)).toBe("KEEP");
    expect(byRef.get(mesattaOld)).toBe("KEEP");
    expect(byRef.get(mesattaApp)).toBe("UNKNOWN");
    expect(byRef.get(mesattaStaging)).toBe("UNKNOWN");
    // Container ativo da Evolution sem tag: protegido por ID real.
    expect(byRef.get(evolutionApp)).toBe("KEEP");
    expect(byRef.get(evolutionStaging)).toBe("UNKNOWN");
    // Nenhuma imagem de produção/staging vira candidata.
    expect(plan.summary.candidate).toBe(0);
  });

  it("apply com o inventário legado não remove ativos, rollback ou staging desconhecido", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    process.env.KORRELO_IMAGE_GC_RETENTION_EXTRA = "0";
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") {
        return { stdout: "korrelo-x-app:latest\tsha256:app\t2026-01-01\nkorrelo-x-app_staging:latest\tsha256:stg\t2026-01-01\n", stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "inspect") return { stdout: "sha256:app\n", stderr: "", exitCode: 0, timedOut: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const service = new ImageGcAuditService(
      { findAll: async () => [{ id: "p1", containerName: "korrelo-x", currentImage: "korrelo-x:commit-abc" }] } as any,
      { findAllByStatus: async () => [] } as any,
      runner as any,
    );
    const plan = await service.audit();
    expect(plan.decisions.every((d) => d.decision !== "CANDIDATE")).toBe(true);
    expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  it("apply explícito é respeitado e não remove sem candidatos", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    const { service } = harness();

    const plan = await service.audit();

    expect(plan.mode).toBe("apply");
  });
});
