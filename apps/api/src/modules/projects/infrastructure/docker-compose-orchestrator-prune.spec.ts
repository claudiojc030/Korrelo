import { execFile } from "node:child_process";
import {
  BUILD_CACHE_RESERVE,
  DockerComposeOrchestrator,
} from "./docker-compose-orchestrator";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

interface RecordedCall {
  args: string[];
  timeout?: number;
}

/**
 * LIMPEZA DE CACHE DE BUILD (Wave 1).
 *
 * Garantias travadas aqui:
 * - só dois comandos: `docker image prune -f` e `docker builder prune -f
 *   --reserved-space 2GB`;
 * - NUNCA `-a`, `rmi`, `volume` ou `system prune` (imagens commit-*, volumes
 *   e containers ficam intocados);
 * - falha de um comando não impede o outro e não lança.
 */
describe("pruneUnusedBuildArtifacts", () => {
  let calls: RecordedCall[];

  function mockDocker(handler: (call: RecordedCall) => { error?: Error; stdout?: string; stderr?: string }) {
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [, args, options] = all as [string, string[], { timeout?: number } | undefined];
      const call: RecordedCall = { args: args ?? [], timeout: options?.timeout };
      calls.push(call);
      const outcome = handler(call);
      if (outcome.error) callback(outcome.error);
      else callback(null, { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
    });
  }

  beforeEach(() => {
    calls = [];
    mockedExecFile.mockReset();
  });

  it("executa exatamente os dois prunes seguros, com a reserva de 2GB", async () => {
    mockDocker(() => ({}));

    const result = await new DockerComposeOrchestrator().pruneUnusedBuildArtifacts();

    expect(calls.map((call) => call.args)).toEqual([
      ["image", "prune", "-f"],
      ["builder", "prune", "-f", "--reserved-space", BUILD_CACHE_RESERVE],
    ]);
    // `image prune` mantém o timeout de 60s; o prune do cache (que pode
    // remover vários GB) tem limite próprio de 5 min - sempre FINITO.
    expect(calls[0].timeout).toBe(60_000);
    expect(calls[1].timeout).toBe(300_000);
    expect(BUILD_CACHE_RESERVE).toBe("2GB");
    expect(result.imagePrune.ok).toBe(true);
    expect(result.builderPrune.ok).toBe(true);
    expect(result.reservedSpace).toBe("2GB");
  });

  it("nunca usa -a, rmi, volume prune ou system prune", async () => {
    mockDocker(() => ({}));

    await new DockerComposeOrchestrator().pruneUnusedBuildArtifacts();

    for (const call of calls) {
      const joined = call.args.join(" ");
      expect(joined).not.toMatch(/(^|\s)-a(\s|$)/);
      expect(joined).not.toContain("rmi");
      expect(joined).not.toContain("image rm");
      expect(joined).not.toContain("volume");
      expect(joined).not.toContain("system prune");
    }
  });

  it("falha do builder prune não impede o image prune nem lança", async () => {
    mockDocker((call) =>
      call.args[0] === "builder" ? { error: new Error("flag não suportada") } : {},
    );

    const result = await new DockerComposeOrchestrator().pruneUnusedBuildArtifacts();

    expect(calls).toHaveLength(2);
    expect(result.imagePrune.ok).toBe(true);
    expect(result.builderPrune.ok).toBe(false);
    expect(result.builderPrune.error).toContain("flag não suportada");
  });

  it("falha total (Docker fora) é reportada e não lança", async () => {
    mockDocker(() => ({ error: new Error("docker indisponível") }));

    const result = await new DockerComposeOrchestrator().pruneUnusedBuildArtifacts();

    expect(result.imagePrune.ok).toBe(false);
    expect(result.builderPrune.ok).toBe(false);
    expect(result.imagePrune.error).toContain("docker indisponível");
    expect(result.builderPrune.error).toContain("docker indisponível");
  });
});
