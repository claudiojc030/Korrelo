import { execFile } from "node:child_process";
import { DockerComposeOrchestrator } from "./docker-compose-orchestrator";
import type { DeployConfig } from "../domain/container-orchestrator";

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
}));

const mockedExecFile = execFile as unknown as jest.Mock;

interface RecordedCall {
  command: string;
  args: string[];
  timeout?: number;
  cwd?: string;
}

/**
 * TIMEOUT DO BUILD/SUBIDA DO STAGING.
 *
 * O deploy do Mesatta foi morto em ~900s (o timeout do comando) durante
 * "Linting and checking validity of types ..." - não era erro de build.
 * O comando de staging agora pode esperar até 1800s.
 *
 * Nada aqui espera de verdade: o execFile é mockado. O que se garante:
 *  - o build do staging recebe 1_800_000 ms (e não 900_000);
 *  - o timeout continua FINITO e aborta o comando quando expira;
 *  - a falha continua sendo a mesma exceção controlada que o caso de uso
 *    usa para marcar o job como falho, limpar o staging e NÃO promover
 *    (coberto em deploy-project.use-case.spec.ts e deploy-safety.spec.ts,
 *    que verificam removeStaging + produção intacta);
 *  - os timeouts das OUTRAS etapas (promoção, remoção, prune, inspect)
 *    não mudaram.
 */
describe("timeout da subida do staging", () => {
  const config: DeployConfig = {
    projectPath: "/tmp/proj",
    containerName: "korrelo-mesatta-8452004c",
    hostPort: 3100,
    containerPort: 3000,
    memoryLimitMb: 1757,
    staging: { containerName: "korrelo-mesatta-8452004c-staging", hostPort: 3101, memoryLimitMb: 304 },
    databases: [],
    imageName: "korrelo-mesatta-8452004c",
    imageTag: "commit-abc",
    envFilePath: "/tmp/secrets/.env.korrelo",
    projectId: "8452004c",
    deployJobId: "job-1",
    commitSha: "abc",
  };

  let calls: RecordedCall[];

  /**
   * Mock do execFile com o mesmo contrato que o promisify do orchestrator
   * espera. Por padrão tudo dá certo; as sondas de nice/ionice falham para
   * manter o comando "cru" (sem wrapper) nas asserções.
   */
  function mockExec(
    outcome: (call: RecordedCall) => { error?: Error; stdout?: string; stderr?: string } = () => ({}),
  ): void {
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [command, args, options] = all as [string, string[], { timeout?: number; cwd?: string } | undefined];
      const call: RecordedCall = {
        command,
        args: args ?? [],
        timeout: options?.timeout,
        cwd: options?.cwd,
      };
      calls.push(call);

      if (command === "nice" || command === "ionice") {
        callback(new Error("nao instalado"));
        return;
      }

      const result = outcome(call);
      if (result.error) callback(result.error);
      else callback(null, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    });
  }

  function composeUpCall(target: string): RecordedCall | undefined {
    return calls.find(
      (call) =>
        call.command === "docker" &&
        call.args[0] === "compose" &&
        call.args.includes("up") &&
        call.args.includes(target),
    );
  }

  beforeEach(() => {
    calls = [];
    mockedExecFile.mockReset();
  });

  it("o build do staging recebe 1800s de timeout (antes eram 900s)", async () => {
    mockExec();

    await new DockerComposeOrchestrator().deployStaging(config);

    const staging = composeUpCall("app_staging");
    expect(staging).toBeDefined();
    expect(staging?.timeout).toBe(1_800_000);
    // O valor antigo (15min) nao pode voltar por engano.
    expect(staging?.timeout).not.toBe(900_000);
    // Continua sendo SÓ o staging: build + sem dependencias.
    expect(staging?.args).toContain("--build");
    expect(staging?.args).toContain("--no-deps");
  });

  it("quando o timeout expira o comando é abortado e vira a falha controlada do deploy", async () => {
    const timeoutError = Object.assign(new Error("Command failed: docker compose up -d --build --no-deps app_staging"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    mockExec((call) => (call.args.includes("app_staging") ? { error: timeoutError } : {}));

    await expect(new DockerComposeOrchestrator().deployStaging(config)).rejects.toThrow(
      /Falha ao subir o container de teste/,
    );

    // O limite continua finito e é o novo valor.
    const staging = composeUpCall("app_staging");
    expect(staging?.timeout).toBe(1_800_000);
    expect(Number.isFinite(staging?.timeout)).toBe(true);
  });

  it("os timeouts das outras etapas do deploy não mudaram", async () => {
    mockExec();
    const orchestrator = new DockerComposeOrchestrator();

    await orchestrator.deployStaging(config);
    await orchestrator.promote(config, {
      deployJobId: "job-1",
      projectId: "8452004c",
      containerName: config.containerName,
      kind: "promote",
    });
    await orchestrator.removeStaging(config);

    const promote = composeUpCall("app");
    expect(promote?.timeout).toBe(120_000);

    const inspect = calls.find((call) => call.args[0] === "image" && call.args[1] === "inspect");
    expect(inspect?.timeout).toBe(20_000);

    const remove = calls.find((call) => call.args[0] === "compose" && call.args.includes("rm"));
    expect(remove?.timeout).toBe(30_000);

    const pruneImage = calls.find((call) => call.args[0] === "image" && call.args[1] === "prune");
    expect(pruneImage?.timeout).toBe(60_000);

    const pruneBuilder = calls.find((call) => call.args[0] === "builder" && call.args[1] === "prune");
    expect(pruneBuilder?.timeout).toBe(60_000);

    // Nenhuma etapa fora do staging herdou os 30min.
    const others = calls.filter((call) => !call.args.includes("app_staging"));
    expect(others.every((call) => call.timeout !== 1_800_000)).toBe(true);
  });
});
