import { execFile } from "node:child_process";
import { DockerPrebuiltImageVerifier } from "./docker-prebuilt-image.verifier";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

describe("DockerPrebuiltImageVerifier", () => {
  beforeEach(() => mockedExecFile.mockReset());

  it("lê identidade e labels sem Config.Env", async () => {
    const stdout =
      "sha256:" +
      "a".repeat(64) +
      '|["repo/app@sha256:' +
      "b".repeat(64) +
      '"]' +
      '|{"korrelo.projectId":"p1","korrelo.commitSha":"' +
      "c".repeat(40) +
      '"}' +
      "|linux|amd64";
    mockedExecFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result: unknown) => void) => {
        callback(null, { stdout, stderr: "" });
      },
    );
    const verifier = new DockerPrebuiltImageVerifier();

    const result = await verifier.verify({
      projectId: "p1",
      commitSha: "c".repeat(40),
      imageReference: "repo/app:commit-cccccccccccc",
      observed: { imageId: "", repoDigests: [], labels: {} },
    });

    expect(result.ok).toBe(true);
    expect(result.identityVerified).toBe(true);
    expect(result.originAuthenticated).toBe(false);
    const args = mockedExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain("Config.Env");
    expect(args[0]).toBe("image");
    expect(args[1]).toBe("inspect");
  });

  it("Docker indisponível falha fechado", async () => {
    mockedExecFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
        callback(new Error("docker offline"));
      },
    );
    const verifier = new DockerPrebuiltImageVerifier();

    const result = await verifier.verify({
      projectId: "p1",
      commitSha: "c".repeat(40),
      imageReference: "repo/app:commit-cccccccccccc",
      observed: { imageId: "", repoDigests: [], labels: {} },
    });

    expect(result.ok).toBe(false);
    expect(result.identityVerified).toBe(false);
  });
});
