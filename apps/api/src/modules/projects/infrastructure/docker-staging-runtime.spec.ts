import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StagingComposeDocument } from "../domain/staging-compose";
import { DockerComposeStagingRuntime } from "./docker-staging-runtime";

const run = {
  id: "run-id",
  projectId: "project-1",
  deployJobId: null,
  runId: "run-1",
  composeProject: "korrelo-stg-project-1-run-1",
  status: "reserved" as const,
  planHash: "plan",
  composeHash: "compose",
  imageReference: "img:commit",
  imageId: null,
  imageDigest: null,
  memoryMb: 256,
  cpu: 0.5,
  diskMb: 512,
  leaseId: "lease-1",
  networkName: "net",
  volumePrefix: "vol",
  ownerId: null,
  cleanupState: "none",
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
};

const lease = {
  id: "lease-1",
  projectId: "project-1",
  runId: "run-1",
  hostPort: 4700,
  status: "active" as const,
  expiresAt: new Date(Date.now() + 60_000),
  memoryMb: 256,
  cpu: 0.5,
  diskMb: 512,
  ownerId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  releasedAt: null,
};

const document: StagingComposeDocument = {
  name: run.composeProject,
  services: {
    app_staging: {
      image: "img:commit",
      container_name: "app-stg",
      networks: ["internal"],
      ports: ["127.0.0.1:4700:3000"],
      mem_limit: "256m",
      labels: {},
    },
  },
  networks: { internal: { name: "net", internal: true } },
  volumes: { uploads: { name: "vol" } },
} as unknown as StagingComposeDocument;

function labels(runId: string, projectId = "project-1") {
  return JSON.stringify({
    "korrelo.stagingRunId": runId,
    "korrelo.projectId": projectId,
    "korrelo.ephemeral": "true",
    "com.docker.compose.project": run.composeProject,
    "com.docker.compose.service": "app_staging",
  });
}

describe("DockerComposeStagingRuntime", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "korrelo-stg-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("inicia com projeto exclusivo e --no-build para imagem pré-construída", async () => {
    const calls: Array<{ args: string[] }> = [];
    const runtime = new DockerComposeStagingRuntime(
      async (command, args) => {
        calls.push({ args });
        return { stdout: "" };
      },
      async () => undefined,
      baseDir,
    );

    await runtime.start({ run, lease, document, composeProject: run.composeProject });

    expect(calls[0].args).toEqual(
      expect.arrayContaining(["compose", "-p", run.composeProject, "up", "-d", "--no-build"]),
    );
  });

  it("cleanup bloqueia quando ownership diverge", async () => {
    const calls: Array<{ args: string[] }> = [];
    const runtime = new DockerComposeStagingRuntime(
      async (_command, args) => {
        calls.push({ args });
        if (args[0] === "ps") return { stdout: "container-1\n" };
        return { stdout: labels("outro-run") };
      },
      async () => undefined,
      baseDir,
    );

    const result = await runtime.cleanup({ run, lease, reason: "teste" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ownership");
    expect(calls.some((call) => call.args.includes("down"))).toBe(false);
  });

  it("cleanup remove somente o projeto do run após verificar labels", async () => {
    const calls: Array<{ args: string[] }> = [];
    const runtime = new DockerComposeStagingRuntime(
      async (_command, args) => {
        calls.push({ args });
        if (args[0] === "ps") return { stdout: "container-1\n" };
        if (args[0] === "inspect") return { stdout: labels(run.runId) };
        return { stdout: "" };
      },
      async () => undefined,
      baseDir,
    );

    const result = await runtime.cleanup({ run, lease, reason: "teste" });

    expect(result.ok).toBe(true);
    const down = calls.find((call) => call.args.includes("down"));
    expect(down?.args).toEqual(
      expect.arrayContaining(["compose", "-p", run.composeProject, "down", "--volumes", "--remove-orphans"]),
    );
  });

  it("health aceita container sem healthcheck quando está rodando", async () => {
    let inspected = 0;
    const runtime = new DockerComposeStagingRuntime(
      async (_command, args) => {
        if (args[0] === "ps") return { stdout: "container-1\n" };
        if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .State}}") {
          inspected += 1;
          return { stdout: JSON.stringify({ Running: true }) };
        }
        return { stdout: labels(run.runId) };
      },
      async () => undefined,
      baseDir,
    );

    const healthy = await runtime.health({ run, lease });

    expect(healthy).toBe(true);
    expect(inspected).toBe(1);
  });

  it("health reprova container unhealthy sem aguardar todas as tentativas", async () => {
    let sleeps = 0;
    const runtime = new DockerComposeStagingRuntime(
      async (_command, args) => {
        if (args[0] === "ps") return { stdout: "container-1\n" };
        if (args[2] === "{{json .State}}") {
          return { stdout: JSON.stringify({ Running: true, Health: { Status: "unhealthy" } }) };
        }
        return { stdout: labels(run.runId) };
      },
      async () => {
        sleeps += 1;
      },
      baseDir,
    );

    const healthy = await runtime.health({ run, lease });

    expect(healthy).toBe(false);
    expect(sleeps).toBe(0);
  });
});
