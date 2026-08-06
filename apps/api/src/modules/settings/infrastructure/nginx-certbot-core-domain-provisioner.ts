import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type { CoreDomainProvisioner } from "../domain/core-domain-provisioner";

const execFile = promisify(execFileCallback);

// Mesmo diretório usado pros domínios de projeto (dono do usuário do Korrelo,
// já incluído no nginx.conf pelo setup-vps.sh), reaproveitado aqui pro
// domínio do próprio painel.
const SITES_DIR = process.env.NGINX_SITES_DIR ?? "/etc/nginx/korrelo-sites";

function siteFilePath(domain: string): string {
  return path.join(SITES_DIR, `${domain}.conf`);
}

// Réplica do bloco escrito por scripts/setup-vps.sh na instalação inicial
// (só que ali só roda se o domínio for informado durante o install): o painel
// do Korrelo usa DUAS portas (web 3000, api 3001), diferente do domínio de um
// projeto que só tem uma porta.
function buildServerBlock(domain: string): string {
  return `server {
  listen 80;
  server_name ${domain};

  location /socket.io/ {
    proxy_pass http://127.0.0.1:3001/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
`;
}

@Injectable()
export class NginxCertbotCoreDomainProvisioner implements CoreDomainProvisioner {
  private readonly logger = new Logger(NginxCertbotCoreDomainProvisioner.name);

  async attach(domain: string, adminEmail: string): Promise<void> {
    await fs.mkdir(SITES_DIR, { recursive: true });
    await fs.writeFile(siteFilePath(domain), buildServerBlock(domain), "utf-8");

    try {
      await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
    } catch (error) {
      await this.removeSiteFile(domain);
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("NGINX_RELOAD_FAILED", `nginx recusou a config do domínio: ${message}`),
      );
    }

    try {
      await execFile(
        "sudo",
        ["certbot", "--nginx", "-d", domain, "-m", adminEmail, "--agree-tos", "--redirect", "-n"],
        { timeout: 2 * 60 * 1000 },
      );
    } catch (error) {
      await this.removeSiteFile(domain);
      await this.reloadNginxIgnoringErrors();
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError(
          "TLS_CERTIFICATE_ISSUANCE_FAILED",
          `Falha ao emitir certificado TLS pro domínio "${domain}": ${message}`,
        ),
      );
    }
  }

  async detach(domain: string): Promise<void> {
    await this.removeSiteFile(domain);
    await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
  }

  private async removeSiteFile(domain: string): Promise<void> {
    await fs.rm(siteFilePath(domain), { force: true });
  }

  private async reloadNginxIgnoringErrors(): Promise<void> {
    try {
      await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
    } catch (error) {
      this.logger.error(`Falha ao recarregar nginx depois de rollback: ${error}`);
    }
  }
}
