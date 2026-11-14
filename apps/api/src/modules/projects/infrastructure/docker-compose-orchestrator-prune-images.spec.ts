import { execFile } from "node:child_process";
import { DockerComposeOrchestrator } from "./docker-compose-orchestrator";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

interface Call {
  args: string[];
}

/**
 * PRUNE LEGADO: nunca pode ser menos conservador que o planejador.
 * Qualquer imagem usada por container (rodando/parado) é protegida por ID;
 * falha de verificação aborta o prune inteiro.
 */
describe("pruneProjectImages — proteção por ID", () => {
  const IMAGE = "korrelo-mesatta-8452004c";
  const current = `${IMAGE}:commit-b162880a5c14`;
  const previous = `${IMAGE}:commit-58d1db22f9a2`;
  const old = `${IMAGE}:commit-111111111111`;

  function run(options: {
    containerImages?: string[];
    ids?: Record<string, string>;
    failInspect?: string;
    extraImages?: string[];
  }) {
    const calls: Call[] = [];
    const ids = options.ids ?? {
      [current]: "sha256:aaa",
      [previous]: "sha256:bbb",
      [old]: "sha256:ccc",
    };
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      const [, args] = all as [string, string[]];
      calls.push({ args });
      const ok = (stdout = "") => callback(null, { stdout, stderr: "" });
      const fail = (message = "erro") => callback(Object.assign(new Error(message), { stdout: "", stderr: message }));

      if (args[0] === "ps") return ok((options.containerImages ?? []).join("\n") + (options.containerImages?.length ? "\n" : ""));
      if (args[0] === "image" && args[1] === "inspect") {
        const reference = args[args.length - 1];
        if (options.failInspect === reference) return fail("inspect falhou");
        return ok(`${ids[reference] ?? "sha256:unknown"}\n`);
      }
      if (args[0] === "images") {
        const base = [
          `${current}\t2026-11-01\t${ids[current]}`,
          `${previous}\t2026-10-20\t${ids[previous]}`,
          `${old}\t2026-08-01\t${ids[old]}`,
        ];
        const extra = (options.extraImages ?? []).map(
          (ref, index) => `${ref}\t2026-07-0${index + 1}\t${ids[ref]}`,
        );
        return ok([...base, ...extra].join("\n") + "\n");
      }
      if (args[0] === "rmi") return ok("");
      return ok("");
    });
    return { calls };
  }

  it("container PARADO compartilhando ID impede a remoção da tag antiga", async () => {
    const { calls } = run({
      containerImages: [current, previous],
      ids: { [current]: "sha256:aaa", [previous]: "sha256:bbb", [old]: "sha256:aaa" },
    });

    const removed = await new DockerComposeOrchestrator().pruneProjectImages({
      imageName: IMAGE,
      protectedImages: [current, previous],
    });

    expect(removed).toBe("");
    expect(calls.some((call) => call.args[0] === "rmi")).toBe(false);
  });

  it("falha de inspect em referência protegida aborta o prune", async () => {
    const { calls } = run({ containerImages: [current], failInspect: current });

    const removed = await new DockerComposeOrchestrator().pruneProjectImages({
      imageName: IMAGE,
      protectedImages: [current, previous],
    });

    expect(removed).toBe("");
    expect(calls.some((call) => call.args[0] === "rmi")).toBe(false);
  });

  it("remove apenas tags antigas fora da retenção e sem ID protegido", async () => {
    const olds = [1, 2, 3, 4].map((n) => `${IMAGE}:commit-${String(n).repeat(12)}`);
    const ids: Record<string, string> = {
      [current]: "sha256:aaa",
      [previous]: "sha256:bbb",
    };
    olds.forEach((ref, index) => {
      ids[ref] = `sha256:old${index}`;
    });
    const { calls } = run({
      containerImages: [current],
      ids,
      extraImages: olds,
    });

    const removed = await new DockerComposeOrchestrator().pruneProjectImages({
      imageName: IMAGE,
      protectedImages: [current, previous],
    });

    // Retenção atual mantém as 3 mais novas; a mais antiga sai.
    expect(removed).toContain(olds[0]);
    expect(calls.some((call) => call.args[0] === "rmi" && call.args[1] === olds[0])).toBe(true);
  });
});
