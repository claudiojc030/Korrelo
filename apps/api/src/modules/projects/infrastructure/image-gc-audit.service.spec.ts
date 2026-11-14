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

  it("política atual mantém a candidata mais nova (simulação)", async () => {
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

  it("apply é rebaixado para dry-run nesta fase", async () => {
    process.env.KORRELO_IMAGE_GC_MODE = "apply";
    const { service } = harness();

    const plan = await service.audit();

    expect(plan.mode).toBe("dry-run");
  });
});
