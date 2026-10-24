import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KORRELO_CERTBOT_HELPER } from "../../../infrastructure/privileged-helpers";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

/**
 * O provisioner do domínio do PAINEL também usa o helper restrito: só o
 * domínio é passado, as flags ficam fixas no helper.
 */
describe("NginxCertbotCoreDomainProvisioner (helper restrito)", () => {
  let sitesDir: string;
  let provisioner: { attach: (domain: string) => Promise<void> };

  beforeAll(() => {
    sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-core-sites-"));
    process.env.NGINX_SITES_DIR = sitesDir;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NginxCertbotCoreDomainProvisioner } = require("./nginx-certbot-core-domain-provisioner");
    provisioner = new NginxCertbotCoreDomainProvisioner();
  });

  afterAll(() => {
    delete process.env.NGINX_SITES_DIR;
    fs.rmSync(sitesDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...all: unknown[]) => {
      const callback = all[all.length - 1] as (error: unknown, result?: unknown) => void;
      callback(null, { stdout: "", stderr: "" });
    });
  });

  it("chama o helper com o domínio do painel", async () => {
    await provisioner.attach("painel.exemplo.com");

    const sudoCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "sudo");
    const certbotCall = sudoCalls.find(
      (call) => (call[1] as string[])[0] === KORRELO_CERTBOT_HELPER,
    );
    expect(certbotCall?.[1]).toEqual([KORRELO_CERTBOT_HELPER, "painel.exemplo.com"]);
  });

  it("não executa certbot direto nem flags arbitrárias", async () => {
    await provisioner.attach("painel.exemplo.com");

    for (const call of mockedExecFile.mock.calls) {
      const args = (call[1] as string[]) ?? [];
      expect(args[0]).not.toBe("certbot");
      expect(args.join(" ")).not.toMatch(/deploy-hook|post-hook|pre-hook|--exec/);
    }
  });
});
