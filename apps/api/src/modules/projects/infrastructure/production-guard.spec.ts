import { execFile } from "node:child_process";
import { DockerComposeOrchestrator } from "./docker-compose-orchestrator";
import type { DeployConfig } from "../domain/container-orchestrator";

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
}));

const mockedExecFile = execFile as unknown as jest.Mock;

/**
 * Guarda de produção (Wave 2.1, Objetivo 10).
 *
 * Nenhuma operação que afete o container de PRODUÇÃO (promover, fazer
 * rollback) pode acontecer sem o contexto completo de um DeployJob. Sem
 * isso, a operação é recusada ANTES de qualquer comando no Docker.
 */
describe("guarda de produção (ProductionAction)", () => {
  const orchestrator = new DockerComposeOrchestrator();

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

  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("promover SEM o contexto de job é recusado (e nada é executado no Docker)", async () => {
    await expect(orchestrator.promote(config)).rejects.toThrow(/recusada/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("promover com container alvo diferente do projeto é recusado", async () => {
    await expect(
      orchestrator.promote(config, {
        deployJobId: "job-1",
        projectId: "8452004c",
        containerName: "korrelo-outro-projeto",
        kind: "promote",
      }),
    ).rejects.toThrow(/não é o de produção do projeto/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("promover sem projectId é recusado", async () => {
    await expect(
      orchestrator.promote(config, {
        deployJobId: "job-1",
        projectId: "",
        containerName: config.containerName,
        kind: "promote",
      }),
    ).rejects.toThrow(/projeto inválido/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("rollback sem imagem anterior é recusado", async () => {
    await expect(
      orchestrator.rollback(config, "", {
        deployJobId: "job-1",
        projectId: "8452004c",
        containerName: config.containerName,
        kind: "rollback",
      }),
    ).rejects.toThrow(/recusado/);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("rollback com contexto válido e imagem existente executa (reverte só a aplicação)", async () => {
    mockedExecFile.mockImplementation((command: string, args: string[], options: any, callback: any) => {
      // O promisify do Node resolve {stdout, stderr} no execFile real; com o
      // módulo mockado, o wrapper genérico resolve o primeiro valor - então
      // o mock entrega o mesmo formato.
      if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
        callback(null, { stdout: "[]", stderr: "" });
        return;
      }
      if (command === "docker" && args[0] === "compose") {
        callback(null, { stdout: "rollback ok", stderr: "" });
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    });

    const output = await orchestrator.rollback(config, "korrelo-mesatta-8452004c:commit-anterior", {
      deployJobId: "job-1",
      projectId: "8452004c",
      containerName: config.containerName,
      kind: "rollback",
      previousImage: "korrelo-mesatta-8452004c:commit-anterior",
    });

    expect(output).toContain("rollback ok");
    // O compose do rollback NÃO tem nenhum comando de volume/banco.
    const composeCall = mockedExecFile.mock.calls.find(
      (call) => (call[1] ?? [])[0] === "compose",
    );
    const args = (composeCall?.[1] ?? []) as string[];
    expect(args).toContain("--no-deps");
    expect(args.join(" ")).not.toContain("-v");
    expect(args.join(" ")).not.toContain("volume");
  });
});
