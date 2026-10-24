import { execFile } from "node:child_process";
import { DockerComposeOrchestrator } from "./docker-compose-orchestrator";
import type { DeployConfig, ProductionAction } from "../domain/container-orchestrator";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

interface RecordedCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * SEGURANÇA DE IMAGEM/COMPOSE (W3).
 *
 * Garantias travadas aqui:
 *  - nenhuma operação que sobe container roda sem tag explícita;
 *  - a tag vem do Korrelo e VENCE `process.env` e `.env` do projeto
 *    (`--env-file` controlado);
 *  - staging/promoção usam o compose do job; rollback usa o estável;
 *  - rollback recusa imagem que não pertence ao projeto (rename).
 */
describe("imagem e compose nas operações do Compose", () => {
  const stable = "docker-compose.korrelo.yml";
  const jobFile = "docker-compose.korrelo.job-job-1.yml";

  function baseConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
    return {
      projectPath: "/tmp/proj",
      containerName: "korrelo-mesatta-8452004c",
      hostPort: 3100,
      containerPort: 3000,
      memoryLimitMb: 1757,
      staging: { containerName: "korrelo-mesatta-8452004c-staging", hostPort: 3101 },
      databases: [],
      imageName: "korrelo-mesatta-8452004c",
      imageTag: "commit-aaaaaaabbbbb",
      composeFilePath: jobFile,
      composeEnvFilePath: "/tmp/secrets/.compose.job-1.env",
      envFilePath: "/tmp/secrets/.env.korrelo",
      projectId: "8452004c",
      deployJobId: "job-1",
      commitSha: "aaaaaaabbbbb",
      ...overrides,
    };
  }

  const action: ProductionAction = {
    deployJobId: "job-1",
    projectId: "8452004c",
    containerName: "korrelo-mesatta-8452004c",
    kind: "promote",
  };

  let calls: RecordedCall[];

  beforeAll(() => {
    // Se algum dia a tag do Core vazar, ela NÃO pode escolher a imagem.
    process.env.KORRELO_IMAGE_TAG = "commit-vazada-do-core";
  });

  afterAll(() => {
    delete process.env.KORRELO_IMAGE_TAG;
  });

  beforeEach(() => {
    calls = [];
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [command, args, options] = all as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv; cwd?: string } | undefined,
      ];
      calls.push({ command, args: args ?? [], env: options?.env, cwd: options?.cwd });
      if (command === "nice" || command === "ionice") {
        callback(new Error("nao instalado"));
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    });
  });

  it("staging SEM tag explícita é recusado antes de qualquer compose up", async () => {
    await expect(
      new DockerComposeOrchestrator().deployStaging(baseConfig({ imageTag: undefined })),
    ).rejects.toThrow(/KORRELO_IMAGE_TAG/);

    const composeUp = calls.find((call) => call.args[0] === "compose" && call.args.includes("up"));
    expect(composeUp).toBeUndefined();
  });

  it("tag inválida é recusada", async () => {
    await expect(
      new DockerComposeOrchestrator().deployStaging(baseConfig({ imageTag: "commit x; rm -rf /" })),
    ).rejects.toThrow(/Tag de imagem inválida/);
    expect(calls.some((call) => call.args[0] === "compose")).toBe(false);
  });

  it("staging passa a tag no env (vence Core/.env do projeto) e usa compose do job", async () => {
    await new DockerComposeOrchestrator().deployStaging(baseConfig());

    const up = calls.find((call) => call.args[0] === "compose" && call.args.includes("app_staging"));
    expect(up).toBeDefined();
    expect(up?.args).toContain(jobFile);
    expect(up?.args).toContain("--env-file");
    expect(up?.args).toContain("/tmp/secrets/.compose.job-1.env");
    expect(up?.args).toContain("--build");
    expect(up?.env?.KORRELO_IMAGE_TAG).toBe("commit-aaaaaaabbbbb");
  });

  it("promoção usa a tag explícita e --no-build quando a imagem já existe", async () => {
    await new DockerComposeOrchestrator().promote(baseConfig(), action);

    const up = calls.find((call) => call.args[0] === "compose" && call.args.includes("app"));
    expect(up).toBeDefined();
    expect(up?.args).toContain(jobFile);
    expect(up?.args).toContain("--no-build");
    expect(up?.args).toContain("--force-recreate");
    expect(up?.env?.KORRELO_IMAGE_TAG).toBe("commit-aaaaaaabbbbb");
    // O env do Core tinha uma tag plantada: o Korrelo venceu.
    expect(up?.env?.KORRELO_IMAGE_TAG).not.toBe("commit-vazada-do-core");
  });

  it("promoção sem tag explícita é recusada", async () => {
    await expect(
      new DockerComposeOrchestrator().promote(baseConfig({ imageTag: undefined }), action),
    ).rejects.toThrow(/KORRELO_IMAGE_TAG/);
    expect(calls.some((call) => call.args[0] === "compose")).toBe(false);
  });

  it("rollback usa o compose ESTÁVEL e a tag anterior explícita", async () => {
    await new DockerComposeOrchestrator().rollback(
      baseConfig({ composeFilePath: stable, composeEnvFilePath: undefined }),
      "korrelo-mesatta-8452004c:commit-anterior",
      { ...action, kind: "rollback", previousImage: "korrelo-mesatta-8452004c:commit-anterior" },
    );

    const up = calls.find((call) => call.args[0] === "compose" && call.args.includes("app"));
    expect(up).toBeDefined();
    expect(up?.args).toContain(stable);
    expect(up?.args).toContain("--no-build");
    expect(up?.env?.KORRELO_IMAGE_TAG).toBe("commit-anterior");
    expect(up?.env?.KORRELO_IMAGE_TAG).not.toBe("commit-vazada-do-core");
  });

  it("rollback recusa imagem de outro projeto (projeto renomeado)", async () => {
    await expect(
      new DockerComposeOrchestrator().rollback(
        baseConfig({ composeFilePath: stable }),
        "korrelo-outro-nome:commit-antiga",
        {
          ...action,
          kind: "rollback",
          previousImage: "korrelo-outro-nome:commit-antiga",
        },
      ),
    ).rejects.toThrow(/não pertence a este projeto/);
    expect(calls.some((call) => call.args[0] === "compose")).toBe(false);
  });

  it("remoção do staging usa o compose do job", async () => {
    await new DockerComposeOrchestrator().removeStaging({
      projectPath: "/tmp/proj",
      containerName: "korrelo-mesatta-8452004c",
      composeFilePath: jobFile,
    });

    const rm = calls.find((call) => call.args[0] === "compose" && call.args.includes("rm"));
    expect(rm?.args).toContain(jobFile);
    expect(rm?.args).toContain("app_staging");
  });
});

/**
 * INSPEÇÃO DO CONTAINER DE PRODUÇÃO (P1-3).
 *
 * Só é `known` quando a referência do container é `repo:tag` E o ID resolvido
 * dessa referência é exatamente o ID da imagem em execução. Qualquer dúvida é
 * `unverified` (nunca "produção intocada").
 */
describe("inspectProductionContainer", () => {
  const orchestrator = new DockerComposeOrchestrator();

  function mockDocker(handler: (args: string[]) => { error?: Error; stdout?: string; stderr?: string }) {
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [, args] = all as [string, string[]];
      const outcome = handler(args ?? []);
      if (outcome.error) callback(outcome.error);
      else callback(null, { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
    });
  }

  it("container verificado: referência repo:tag e ID idêntico", async () => {
    mockDocker((args) => {
      if (args[0] === "image") return { stdout: "sha256:bbb\n" };
      return { stdout: "cid123|sha256:bbb|korrelo-x:commit-abc\n" };
    });

    const state = await orchestrator.inspectProductionContainer("korrelo-x");
    expect(state).toEqual({
      kind: "known",
      containerId: "cid123",
      imageReference: "korrelo-x:commit-abc",
      imageId: "sha256:bbb",
    });
  });

  it("container inexistente -> absent (único caso tratado como 'sem produção')", async () => {
    mockDocker(() => {
      const error = Object.assign(new Error("Command failed"), {
        stdout: "",
        stderr: "Error: No such object: korrelo-x",
      });
      return { error };
    });

    await expect(orchestrator.inspectProductionContainer("korrelo-x")).resolves.toEqual({ kind: "absent" });
  });

  it("falha do Docker -> unverified (nunca assume produção intocada)", async () => {
    mockDocker(() => {
      const error = Object.assign(new Error("spawn EAGAIN"), { stdout: "", stderr: "" });
      return { error };
    });

    const state = await orchestrator.inspectProductionContainer("korrelo-x");
    expect(state.kind).toBe("unverified");
  });

  it("referência sem tag (ID solto) -> unverified", async () => {
    mockDocker((args) => {
      if (args[0] === "image") return { stdout: "sha256:bbb" };
      return { stdout: "cid123|sha256:bbb|sha256:bbb\n" };
    });

    const state = await orchestrator.inspectProductionContainer("korrelo-x");
    expect(state.kind).toBe("unverified");
  });

  it("referência que resolve para outro ID -> unverified", async () => {
    mockDocker((args) => {
      if (args[0] === "image") return { stdout: "sha256:outro" };
      return { stdout: "cid123|sha256:bbb|korrelo-x:latest\n" };
    });

    const state = await orchestrator.inspectProductionContainer("korrelo-x");
    expect(state.kind).toBe("unverified");
  });
});
