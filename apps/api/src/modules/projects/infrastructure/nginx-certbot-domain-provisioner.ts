import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DomainProvisioner } from "../domain/domain-provisioner";

const execFile = promisify(execFileCallback);

// Diretório dedicado (não /etc/nginx/sites-available inteiro). O setup-vps.sh
// faz esse diretório pertencer ao usuário do ForgeDesk, então a API escreve os
// arquivos direto, sem sudo. Só reload do nginx e o certbot em si precisam de
// sudo (regra restrita em /etc/sudoers.d/forgedesk, ver scripts/setup-vps.sh).
const SITES_DIR = process.env.NGINX_SITES_DIR ?? "/etc/nginx/forgedesk-sites";

function siteFilePath(domain: string): string {
  return path.join(SITES_DIR, `${domain}.conf`);
}

function buildServerBlock(domain: string, port: number): string {
  return `server {
  listen 80;
  server_name ${domain};

  location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
`;
}

@Injectable()
export class NginxCertbotDomainProvisioner implements DomainProvisioner {
  private readonly logger = new Logger(NginxCertbotDomainProvisioner.name);

  async attach(domain: string, port: number, adminEmail: string): Promise<void> {
    await fs.mkdir(SITES_DIR, { recursive: true });
    await fs.writeFile(siteFilePath(domain), buildServerBlock(domain, port), "utf-8");

    try {
      await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
    } catch (error) {
      await this.removeSiteFile(domain);
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`nginx recusou a config do domínio: ${message}`);
    }

    try {
      // --nginx edita esse mesmo server block pra adicionar o 443 + redirect
      // automaticamente depois de emitir o certificado.
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
        `Falha ao emitir certificado TLS pro domínio "${domain}": ${message}`,
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
