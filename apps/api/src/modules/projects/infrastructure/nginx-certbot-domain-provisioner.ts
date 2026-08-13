import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { apiError } from "../../../infrastructure/api-error";
import type { DomainProvisioner } from "../domain/domain-provisioner";

const execFile = promisify(execFileCallback);

// Diretório dedicado (não /etc/nginx/sites-available inteiro). O setup-vps.sh
// faz esse diretório pertencer ao usuário do Korrelo, então a API escreve os
// arquivos direto, sem sudo. Só reload do nginx e o certbot em si precisam de
// sudo (regra restrita em /etc/sudoers.d/korrelo, ver scripts/setup-vps.sh).
const SITES_DIR = process.env.NGINX_SITES_DIR ?? "/etc/nginx/korrelo-sites";

// Um arquivo por projeto, nomeado pelo domínio PRINCIPAL (domains[0]) - os
// demais (aliases, ex.: www) entram no mesmo arquivo, no mesmo server_name,
// compartilhando o mesmo certificado.
function siteFilePath(primaryDomain: string): string {
  return path.join(SITES_DIR, `${primaryDomain}.conf`);
}

function buildServerBlock(domains: string[], port: number): string {
  return `server {
  listen 80;
  server_name ${domains.join(" ")};

  location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # HSTS: depois da primeira visita em HTTPS, o navegador do visitante nunca
    # mais tenta HTTP puro pra esse domínio de novo (nem se um proxy de
    # operadora de celular tentar interceptar a conexão HTTP antes do redirect
    # pro HTTPS acontecer). O certbot clona esse location pro bloco 443 que
    # ele mesmo cria, então o header vale pra ambos.
    # SEM includeSubDomains: um subdomínio que não esteja na lista acima (sem
    # certificado nem configuração) travaria o navegador com um erro de HSTS
    # sem nenhum jeito de contornar.
    add_header Strict-Transport-Security "max-age=31536000" always;
  }
}
`;
}

@Injectable()
export class NginxCertbotDomainProvisioner implements DomainProvisioner {
  private readonly logger = new Logger(NginxCertbotDomainProvisioner.name);

  async attach(domains: string[], port: number): Promise<void> {
    const primaryDomain = domains[0];
    await fs.mkdir(SITES_DIR, { recursive: true });
    await fs.writeFile(siteFilePath(primaryDomain), buildServerBlock(domains, port), "utf-8");

    try {
      await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
    } catch (error) {
      await this.removeSiteFile(primaryDomain);
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError("NGINX_RELOAD_FAILED", `nginx recusou a config do domínio: ${message}`),
      );
    }

    try {
      // --nginx edita esse mesmo server block pra adicionar o 443 + redirect
      // automaticamente depois de emitir o certificado, já cobrindo TODOS os
      // domínios passados (--expand reaproveita/expande o certificado
      // existente em vez de criar um separado quando o conjunto de domínios
      // muda, ex.: adicionar www depois). Sem e-mail (o Korrelo não coleta um
      // de verdade do administrador): --register-unsafely-without-email é a
      // forma suportada de pular isso, diferente de inventar um endereço
      // fake tipo "admin@localhost", que o Let's Encrypt passou a rejeitar.
      const domainArgs = domains.flatMap((domain) => ["-d", domain]);
      await execFile(
        "sudo",
        ["certbot", "--nginx", ...domainArgs, "--expand", "--register-unsafely-without-email", "--agree-tos", "--redirect", "-n"],
        { timeout: 2 * 60 * 1000 },
      );
    } catch (error) {
      await this.removeSiteFile(primaryDomain);
      await this.reloadNginxIgnoringErrors();
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        apiError(
          "TLS_CERTIFICATE_ISSUANCE_FAILED",
          `Falha ao emitir certificado TLS pro domínio "${primaryDomain}": ${message}`,
        ),
      );
    }
  }

  // Só troca a(s) linha(s) "server_name ...;" mantendo o resto do arquivo
  // intacto - inclusive o bloco 443 (cert, redirect) que o certbot já escreveu
  // por cima do nosso template original. Reescrever com o template puro aqui
  // apagaria esse bloco inteiro.
  async updateServerNames(domains: string[]): Promise<void> {
    const filePath = siteFilePath(domains[0]);
    const current = await fs.readFile(filePath, "utf-8");
    const updated = current.replace(/server_name\s+[^;]+;/g, `server_name ${domains.join(" ")};`);
    await fs.writeFile(filePath, updated, "utf-8");
    await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
  }

  async detach(domains: string[]): Promise<void> {
    await this.removeSiteFile(domains[0]);
    await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
  }

  private async removeSiteFile(primaryDomain: string): Promise<void> {
    await fs.rm(siteFilePath(primaryDomain), { force: true });
  }

  private async reloadNginxIgnoringErrors(): Promise<void> {
    try {
      await execFile("sudo", ["systemctl", "reload", "nginx"], { timeout: 15_000 });
    } catch (error) {
      this.logger.error(`Falha ao recarregar nginx depois de rollback: ${error}`);
    }
  }
}
