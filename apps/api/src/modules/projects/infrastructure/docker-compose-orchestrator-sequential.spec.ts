import { execFile } from "node:child_process";
import { DockerComposeOrchestrator } from "./docker-compose-orchestrator";
import type { DeployConfig } from "../domain/container-orchestrator";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

interface RecordedCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function config(): DeployConfig {
  return {
    projectPath: "/tmp/proj",
    containerName: "korrelo-mesatta-8452004c",
    hostPort: 3100,
    containerPort: 3000,
    memoryLimitMb: 1757,
    staging: { containerName: "korrelo-mesatta-8452004c-staging", hostPort: 3101, memoryLimitMb: 768 },
    databases: [],
    imageName: "korrelo-mesatta-8452004c",
    imageTag: "commit-aaaaaaabbbbb",
    composeFilePath: "docker-compose.korrelo.job-1.yml",
    composeEnvFilePath: "/tmp/.compose.env",
  };
}

describe("DockerComposeOrchestrator - pipeline sequencial", () => {
  let calls: RecordedCall[];

  beforeEach(() => {
    calls = [];
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [command, args, options] = all as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv } | undefined,
      ];
      calls.push({ command, args: args ?? [], env: options?.env });
      if (command === "nice" || command === "ionice") {
        callback(new Error("nao instalado"));
        return;
      }
      if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
        callback(null, { stdout: `sha256:${"1".repeat(64)}\n`, stderr: "" });
        return;
      }
      if (command === "docker" && args[0] === "inspect") {
        callback(null, { stdout: `sha256:${"1".repeat(64)}\n`, stderr: "" });
        return;
      }
      callback(null, { stdout: "ok", stderr: "" });
    });
  });

  it("build usa compose build app_staging e não sobe container", async () => {
    await new DockerComposeOrchestrator().buildCandidate(config());

    const compose = calls.find((call) => call.command === "docker" && call.args.includes("compose"));
    expect(compose).toBeDefined();
    const args = compose!.args.join(" ");
    expect(args).toContain("compose");
    expect(args).toContain("docker-compose.korrelo.job-1.yml");
    expect(args).toContain("build app_staging");
    expect(args).not.toContain(" up ");
    expect(compose!.env?.KORRELO_IMAGE_TAG).toBe("commit-aaaaaaabbbbb");
  });

  it("staging sobe com --no-build e --no-deps (sem build duplicado)", async () => {
    await new DockerComposeOrchestrator().startStaging(config());

    const compose = calls.find((call) => call.command === "docker" && call.args.includes("compose"));
    expect(compose).toBeDefined();
    const args = compose!.args.join(" ");
    expect(args).toContain("up -d --no-build --no-deps app_staging");
    expect(args).not.toContain("--build");
    expect(compose!.env?.KORRELO_IMAGE_TAG).toBe("commit-aaaaaaabbbbb");
  });

  it("recusa build/start sem tag explícita", async () => {
    await expect(
      new DockerComposeOrchestrator().buildCandidate({ ...config(), imageTag: undefined }),
    ).rejects.toThrow(/KORRELO_IMAGE_TAG/);
    await expect(
      new DockerComposeOrchestrator().startStaging({ ...config(), imageTag: undefined }),
    ).rejects.toThrow(/KORRELO_IMAGE_TAG/);
  });

  it("imageId devolve apenas sha256 completo e null em falha", async () => {
    const orchestrator = new DockerComposeOrchestrator();
    expect(await orchestrator.imageId("korrelo-x:commit-abc")).toBe(`sha256:${"1".repeat(64)}`);

    mockedExecFile.mockImplementationOnce((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown) => void;
      callback(new Error("ausente"));
    });
    expect(await orchestrator.imageId("korrelo-x:commit-abc")).toBeNull();
    expect(await orchestrator.imageId("sha256:abc")).toBeNull();
  });

  it("containerImageId lê .Image do container e recusa valor inválido", async () => {
    const orchestrator = new DockerComposeOrchestrator();
    expect(await orchestrator.containerImageId("korrelo-mesatta-staging")).toBe(
      `sha256:${"1".repeat(64)}`,
    );

    mockedExecFile.mockImplementationOnce((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      callback(null, { stdout: "nao-e-imagem\n", stderr: "" });
    });
    expect(await orchestrator.containerImageId("korrelo-mesatta-staging")).toBeNull();
  });
});
