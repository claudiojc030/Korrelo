import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_CATALOG } from "../modules/system-services/domain/service-catalog";

/**
 * REGRESSÃO DAS PERMISSÕES PRIVILEGIADAS.
 *
 * A auditoria encontrou `NOPASSWD: certbot *` (hook arbitrário como root) e
 * `NOPASSWD: systemctl enable --now *` (qualquer unit). Estes testes travam a
 * configuração restrita: qualquer reintrodução de curinga falha aqui.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf-8");
}

/** Remove linhas de comentário (as regras antigas são citadas nelas). */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("permissões privilegiadas do Korrelo", () => {
  const setup = read("scripts/setup-vps.sh");
  // Comentários citam a regra antiga de propósito; as asserções de "sem
  // curinga" valem só para o código executável.
  const setupCode = setup
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  const certbotHelper = read("scripts/lib/korrelo-certbot.sh");
  const serviceHelper = read("scripts/lib/korrelo-service.sh");
  const certbotCode = stripComments(certbotHelper);
  const serviceCode = stripComments(serviceHelper);

  describe("setup-vps.sh", () => {
    it("não concede mais `certbot *` nem `systemctl enable/disable --now *`", () => {
      expect(setupCode).not.toMatch(/certbot\s+\*/);
      expect(setupCode).not.toMatch(/systemctl\s+enable\s+--now\s+\*/);
      expect(setupCode).not.toMatch(/systemctl\s+disable\s+--now\s+\*/);
    });

    it("instala os dois helpers como root e concede sudo só a eles", () => {
      expect(setup).toContain("scripts/lib/korrelo-certbot.sh");
      expect(setup).toContain("scripts/lib/korrelo-service.sh");
      // O sudoers é montado com printf: a linha só tem os helpers (e o reload
      // fixo do nginx), sem curinga.
      expect(setup).toContain("%s ALL=(root) NOPASSWD: %s reload nginx, %s, %s");
      expect(setup).toContain('"${HELPERS_DIR}/korrelo-certbot"');
      expect(setup).toContain('"${HELPERS_DIR}/korrelo-service"');
    });

    it("não chama o certbot direto com sudo (usa o helper)", () => {
      expect(setupCode).not.toMatch(/sudo\s+certbot\s/);
      expect(setup).toContain("korrelo-certbot --email");
    });

    it("não desabilita serviço com systemctl direto (usa o helper)", () => {
      expect(setupCode).not.toMatch(/sudo\s+systemctl\s+disable\s+--now/);
      expect(setup).toContain("korrelo-service disable");
    });
  });

  describe("korrelo-certbot", () => {
    it("monta as flags do certbot internamente (nunca recebe flag do chamador)", () => {
      expect(certbotCode).toContain("args=(--nginx)");
      expect(certbotCode).toContain("--agree-tos");
      expect(certbotCode).toContain("--redirect");
      expect(certbotCode).toContain("--expand");
      // Nenhuma opção perigosa é aceita/repassada.
      expect(certbotCode).not.toMatch(/deploy-hook|post-hook|pre-hook|--exec/);
      expect(certbotCode).not.toMatch(/eval\b/);
    });

    it("valida domínio (FQDN) e e-mail antes de executar", () => {
      expect(certbotCode).toContain("DOMAIN_RE=");
      expect(certbotCode).toContain("domínio inválido");
      expect(certbotCode).toMatch(/e-mail inválido/i);
      expect(certbotCode).toContain("exec \"$CERTBOT_BIN\"");
    });

    it("limita a quantidade de domínios", () => {
      expect(certbotCode).toContain("MAX_DOMAINS=");
      expect(certbotCode).toContain("domínios demais");
    });
  });

  describe("korrelo-service", () => {
    it("só aceita enable/disable", () => {
      expect(serviceCode).toContain('[[ "$ACTION" == "enable" || "$ACTION" == "disable" ]]');
      expect(serviceCode).toContain('exec "$SYSTEMCTL_BIN" "$ACTION" --now "$UNIT"');
    });

    it("mantém a mesma lista fechada do catálogo de serviços da API", () => {
      const match = /ALLOWED_UNITS=\(([\s\S]*?)\n\)/.exec(serviceHelper);
      expect(match).not.toBeNull();
      const allowed = Array.from(match![1].matchAll(/"([^"]+)"/g)).map((entry) => entry[1]);
      const catalog = SERVICE_CATALOG.map((service) => service.unitName);

      expect(allowed.sort()).toEqual(catalog.sort());
    });

    it("não permite unit arbitrária nem serviços essenciais", () => {
      const match = /ALLOWED_UNITS=\(([\s\S]*?)\n\)/.exec(serviceHelper);
      const allowed = Array.from(match![1].matchAll(/"([^"]+)"/g)).map((entry) => entry[1]);
      for (const essential of ["ssh", "ssh.service", "docker", "nginx", "cron", "ufw", "fail2ban"]) {
        expect(allowed).not.toContain(essential);
      }
    });
  });
});
