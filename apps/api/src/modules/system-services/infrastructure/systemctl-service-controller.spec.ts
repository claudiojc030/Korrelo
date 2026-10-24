import { execFile } from "node:child_process";
import { KORRELO_SERVICE_HELPER } from "../../../infrastructure/privileged-helpers";
import { SystemctlServiceController } from "./systemctl-service-controller";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

function mockSuccess() {
  mockedExecFile.mockImplementation((...all: unknown[]) => {
    const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
    callback(null, { stdout: "", stderr: "" });
  });
}

/**
 * O controller não fala mais com `sudo systemctl ...` direto: ele chama o
 * helper restrito, que valida a ação e a unit. Isso impede que um nome de
 * unit arbitrário (ou um serviço essencial) seja habilitado/desabilitado.
 */
describe("SystemctlServiceController (helper restrito)", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    mockSuccess();
  });

  it("habilita um serviço do catálogo pelo helper", async () => {
    await new SystemctlServiceController().setEnabled("cups", true);

    const sudoCall = mockedExecFile.mock.calls.find((call) => call[0] === "sudo");
    expect(sudoCall?.[1]).toEqual([KORRELO_SERVICE_HELPER, "enable", "cups"]);
  });

  it("desabilita um serviço do catálogo pelo helper", async () => {
    await new SystemctlServiceController().setEnabled("bluetooth", false);

    const sudoCall = mockedExecFile.mock.calls.find((call) => call[0] === "sudo");
    expect(sudoCall?.[1]).toEqual([KORRELO_SERVICE_HELPER, "disable", "bluetooth"]);
  });

  it("nunca chama systemctl com --now por sudo (o helper monta a ação)", async () => {
    await new SystemctlServiceController().setEnabled("cups", true);
    await new SystemctlServiceController().setEnabled("cups", false);

    const sudoCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "sudo");
    expect(sudoCalls).toHaveLength(2);
    for (const call of sudoCalls) {
      const args = call[1] as string[];
      expect(args[0]).toBe(KORRELO_SERVICE_HELPER);
      expect(args).not.toContain("--now");
      expect(args).not.toContain("systemctl");
    }
  });
});
