import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KORRELO_CERTBOT_HELPER } from "../../../infrastructure/privileged-helpers";

jest.mock("node:child_process", () => ({ execFile: jest.fn() }));

const mockedExecFile = execFile as unknown as jest.Mock;

/**
 * O provisioner de domínio de PROJETO chama o helper privilegiado, não o
 * certbot direto. Um domínio inválido nunca vira opção do certbot no argv.
 */
describe("NginxCertbotDomainProvisioner (helper restrito)", () => {
  let sitesDir: string;
  let provisioner: { attach: (domains: string[], port: number) => Promise<void> };

  beforeAll(() => {
    sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-nginx-sites-"));
    process.env.NGINX_SITES_DIR = sitesDir;
    // O módulo lê NGINX_SITES_DIR no import.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NginxCertbotDomainProvisioner } = require("./nginx-certbot-domain-provisioner");
    provisioner = new NginxCertbotDomainProvisioner();
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

  it("passa os domínios para o helper (e nada mais)", async () => {
    await provisioner.attach(["mesatta.com.br", "www.mesatta.com.br"], 3002);

    const sudoCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "sudo");
    const certbotCall = sudoCalls.find(
      (call) => (call[1] as string[])[0] === KORRELO_CERTBOT_HELPER,
    );

    expect(certbotCall?.[1]).toEqual([
      KORRELO_CERTBOT_HELPER,
      "mesatta.com.br",
      "www.mesatta.com.br",
    ]);
  });

  it("nunca executa `sudo certbot ...` direto nem repassa flags perigosas", async () => {
    await provisioner.attach(["exemplo.com"], 3000);

    for (const call of mockedExecFile.mock.calls) {
      const args = (call[1] as string[]) ?? [];
      expect(args[0]).not.toBe("certbot");
      expect(args.join(" ")).not.toMatch(/deploy-hook|post-hook|pre-hook|--exec/);
    }
  });

  it("recarrega o nginx com o comando fixo antes de emitir o certificado", async () => {
    await provisioner.attach(["exemplo.com"], 3000);

    const sudoCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "sudo");
    expect((sudoCalls[0]?.[1] as string[]) ?? []).toEqual(["systemctl", "reload", "nginx"]);
  });
});
