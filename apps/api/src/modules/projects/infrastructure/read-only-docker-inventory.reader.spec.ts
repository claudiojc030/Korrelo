import { runCommand } from "../../../infrastructure/command-runner";
import { ReadOnlyDockerInventoryReader } from "./read-only-docker-inventory.reader";

jest.mock("../../../infrastructure/command-runner", () => ({
  runCommand: jest.fn(),
}));

const mockedRunCommand = runCommand as unknown as jest.Mock;

function result(stdout: string, exitCode = 0) {
  return {
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
}

describe("ReadOnlyDockerInventoryReader", () => {
  beforeEach(() => mockedRunCommand.mockReset());

  it("lista containers, redes, volumes, labels e portas sem operações destrutivas", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(
        result(
          [
            'id1\tapp1\trunning\timage1\tcompose-a\tproject-1\tjob-1\trun-1\ttrue\t127.0.0.1:3000->3000/tcp',
            "id2\tunlabeled\texited\timage2\t\t\t\t\t\t",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(result("korrelo-shared\ncompose-a_default\n"))
      .mockResolvedValueOnce(result("uploads-data\ncompose-a-data\n"))
      .mockResolvedValueOnce(result('{"com.docker.compose.project":"compose-a"}'))
      .mockResolvedValueOnce(result("{}"))
      .mockResolvedValueOnce(result("{}"))
      .mockResolvedValueOnce(result('{"com.docker.compose.project":"compose-a"}'));

    const snapshot = await new ReadOnlyDockerInventoryReader().inspect();

    expect(snapshot.complete).toBe(true);
    expect(snapshot.containers).toHaveLength(2);
    expect(snapshot.containers[0]).toMatchObject({
      name: "app1",
      composeProject: "compose-a",
      labels: {
        "com.docker.compose.project": "compose-a",
        "korrelo.projectId": "project-1",
        "korrelo.deployJobId": "job-1",
        "korrelo.stagingRunId": "run-1",
        "korrelo.ephemeral": "true",
      },
      publishedPorts: [3000],
    });
    expect(snapshot.containers[1].labels).toEqual({});
    expect(snapshot.networks.map((network) => network.name)).toEqual([
      "korrelo-shared",
      "compose-a_default",
    ]);
    expect(snapshot.networks[0].labels).toEqual({ "com.docker.compose.project": "compose-a" });
    expect(snapshot.volumes.map((volume) => volume.name)).toEqual(["uploads-data", "compose-a-data"]);
    expect(snapshot.volumes[1].labels).toEqual({ "com.docker.compose.project": "compose-a" });
    expect(snapshot.publishedPorts).toEqual([3000]);

    const commands = mockedRunCommand.mock.calls.map(([command, args]) => [command, ...args]);
    expect(commands).toContainEqual(["docker", "ps", "-a", "--format", expect.any(String)]);
    expect(commands).toContainEqual(["docker", "network", "ls", "--format", "{{.Name}}"]);
    expect(commands).toContainEqual(["docker", "volume", "ls", "--format", "{{.Name}}"]);
    const all = JSON.stringify(commands);
    expect(all).not.toContain('"rm"');
    expect(all).not.toContain('"down"');
    expect(all).not.toContain('"stop"');
    expect(all).not.toContain('"prune"');
    expect(all).not.toContain("Config.Env");
  });

  it("inventário incompleto não é tratado como seguro", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(result(""))
      .mockResolvedValueOnce(result("korrelo-shared\n"))
      .mockResolvedValueOnce(result("", 1));

    const snapshot = await new ReadOnlyDockerInventoryReader().inspect();

    expect(snapshot.complete).toBe(false);
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.containers).toEqual([]);
  });
});
