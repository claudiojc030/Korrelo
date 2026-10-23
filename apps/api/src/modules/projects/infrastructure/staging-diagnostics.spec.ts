import {
  STAGING_DIAGNOSTICS_TAIL_LINES,
  StagingDiagnosticsCollector,
  formatStagingDiagnostics,
  sanitizeDiagnosticText,
  type StagingContainerState,
  type StagingDiagnosticsRuntime,
} from "./staging-diagnostics";

/**
 * DIAGNÓSTICO DO STAGING (somente observabilidade).
 *
 * Nada aqui chama Docker: o runtime é injetado. O que se garante:
 * - os campos certos são capturados (inclusive OOM e exit code);
 * - só os últimos 200 logs são pedidos e eles saem sanitizados;
 * - falha de inspect/logs não perde o resto nem lança;
 * - nenhum segredo (URI, Bearer, token) sobra no texto persistido.
 */
describe("diagnóstico do staging antes do cleanup", () => {
  function state(overrides: Partial<StagingContainerState> = {}): StagingContainerState {
    return {
      containerName: "korrelo-mesatta-staging",
      status: "exited",
      exitCode: 1,
      oomKilled: false,
      restartCount: 0,
      startedAt: "2026-10-22T18:00:00.000000000Z",
      finishedAt: "2026-10-22T18:00:05.000000000Z",
      memoryLimitMb: 600,
      ...overrides,
    };
  }

  function makeRuntime(overrides: Partial<StagingDiagnosticsRuntime> = {}) {
    const calls = { inspect: [] as string[], logs: [] as { containerName: string; tailLines: number }[] };
    const inspect = overrides.inspectState ?? (async () => state());
    const readLogs =
      overrides.readLogs ??
      (async () => "Mesatta rodando em http://localhost:3000\n[db-health] Mongo indisponível");
    const runtime: StagingDiagnosticsRuntime = {
      async inspectState(containerName: string) {
        calls.inspect.push(containerName);
        return inspect(containerName);
      },
      async readLogs(containerName: string, tailLines: number) {
        calls.logs.push({ containerName, tailLines });
        return readLogs(containerName, tailLines);
      },
    };
    return { runtime, calls };
  }

  it("health falha com o processo encerrado: captura ExitCode/Status", async () => {
    const { runtime } = makeRuntime();
    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(capture.state?.status).toBe("exited");
    expect(capture.state?.exitCode).toBe(1);
    expect(capture.state?.restartCount).toBe(0);
    expect(capture.state?.memoryLimitMb).toBe(600);
    expect(capture.state?.startedAt).toContain("2026-10-22");
    expect(capture.errors).toEqual([]);
  });

  it("OOM: captura OOMKilled=true", async () => {
    const { runtime } = makeRuntime({
      inspectState: async () => state({ status: "exited", exitCode: 137, oomKilled: true }),
    });
    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(capture.state?.oomKilled).toBe(true);
    expect(capture.state?.exitCode).toBe(137);
    expect(formatStagingDiagnostics(capture)).toContain("oomKilled: true");
  });

  it("container ainda rodando: captura Status=running (processo vivo sem responder)", async () => {
    const { runtime } = makeRuntime({
      inspectState: async () => state({ status: "running", exitCode: 0, finishedAt: "0001-01-01T00:00:00Z" }),
    });
    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(capture.state?.status).toBe("running");
    expect(formatStagingDiagnostics(capture)).toContain("status: running");
  });

  it("pede somente os últimos 200 logs e sanitiza antes de persistir", async () => {
    const { runtime, calls } = makeRuntime({
      readLogs: async () =>
        [
          "conectando em mongodb://korrelo:SenhaSuperSecreta123@mongo:27017/mesatta?authSource=admin",
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
          "TOKEN_INTERNO=super-secret-value-123456",
          "chave k3Jd9sLq2Xc4Vb8Nn1Pz7Rt5Yu0Wm6Qe4Ii2Oo8Aa",
          "commit abcdef0123456789abcdef0123456789abcdef01",
        ].join("\n"),
    });

    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(calls.logs).toEqual([{ containerName: "korrelo-mesatta-staging", tailLines: STAGING_DIAGNOSTICS_TAIL_LINES }]);
    expect(STAGING_DIAGNOSTICS_TAIL_LINES).toBe(200);

    const text = formatStagingDiagnostics(capture);
    expect(text).not.toContain("SenhaSuperSecreta123");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("super-secret-value-123456");
    expect(text).not.toContain("k3Jd9sLq2Xc4Vb8Nn1Pz7Rt5Yu0Wm6Qe4Ii2Oo8Aa");
    // SHA de commit (40 hex) NÃO é segredo: continua legível no diagnóstico.
    expect(text).toContain("abcdef0123456789abcdef0123456789abcdef01");
  });

  it("inspect falha: captura parcial e o deploy segue com o erro original", async () => {
    const { runtime } = makeRuntime({
      inspectState: async () => {
        throw new Error("No such object: korrelo-mesatta-staging");
      },
    });

    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(capture.state).toBeNull();
    expect(capture.errors[0]).toMatch(/^inspect: /);
    // Os logs continuam sendo coletados.
    expect(capture.logs).toContain("db-health");
    expect(formatStagingDiagnostics(capture)).toContain("estado: indisponível");
  });

  it("leitor de logs falha: mantém o estado e registra diagnóstico parcial", async () => {
    const { runtime } = makeRuntime({
      readLogs: async () => {
        throw new Error("docker logs timed out");
      },
    });

    const capture = await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(capture.state?.exitCode).toBe(1);
    expect(capture.logs).toBeNull();
    expect(capture.errors[0]).toMatch(/^logs: /);
    const text = formatStagingDiagnostics(capture);
    expect(text).toContain("logs: indisponíveis");
    expect(text).toContain("diagnóstico parcial");
  });

  it("nunca consulta outro container além do staging informado", async () => {
    const { runtime, calls } = makeRuntime();

    await new StagingDiagnosticsCollector(runtime).collect("korrelo-mesatta-staging");

    expect(calls.inspect).toEqual(["korrelo-mesatta-staging"]);
    expect(calls.logs.map((call) => call.containerName)).toEqual(["korrelo-mesatta-staging"]);
  });

  describe("sanitização", () => {
    it("mascara credenciais de URLs (mongodb, mongodb+srv, postgres, redis)", () => {
      const text = [
        "mongodb://u:s3nh4@mongo:27017/db",
        "mongodb+srv://u:s3nh4@cluster.example.net/db",
        "postgresql://u:s3nh4@db:5432/x",
        "redis://:s3nh4@redis:6379",
      ].join("\n");

      const out = sanitizeDiagnosticText(text, {});

      expect(out).not.toContain("s3nh4");
      expect(out).toContain("***");
    });

    it("mascara Authorization Bearer e tokens longos", () => {
      const out = sanitizeDiagnosticText(
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nchave=Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7",
        {},
      );

      expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(out).not.toContain("Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7");
    });

    it("não vaza valores de variáveis de ambiente sensíveis", () => {
      const out = sanitizeDiagnosticText("falhou com token super-secreto-123456", {
        API_TOKEN: "super-secreto-123456",
      });

      expect(out).not.toContain("super-secreto-123456");
    });
  });
});
