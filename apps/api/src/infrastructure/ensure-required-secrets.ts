import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { upsertEnvValues } from "./env-file";

// O arquivo de ambiente do Core guarda JWT_SECRET, ENV_ENCRYPTION_KEY e a
// chave privada do GitHub App. Permissão restrita só pro dono (0600) - sem
// isso, qualquer usuário local da VPS lê os segredos da instalação.
const ENV_FILE_MODE = 0o600;

/**
 * Rede de segurança pra JWT_SECRET e ENV_ENCRYPTION_KEY: o instalador
 * (scripts/setup-vps.sh) já gera os dois na primeira instalação, mas essa
 * checagem garante que ISSO SEMPRE ACONTECE pra qualquer forma de rodar a
 * API (setup manual, docker, um instalador futuro que esqueça de gerar),
 * em vez de depender só do script shell não falhar. Sem uma dessas chaves,
 * sessões não autenticam e env vars de projeto não conseguem ser cifradas.
 */
export function ensureRequiredSecrets(): void {
  const envPath = path.join(process.cwd(), ".env");
  const generated: Record<string, string> = {};

  if (!process.env.JWT_SECRET) {
    generated.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  }
  if (!process.env.ENV_ENCRYPTION_KEY) {
    generated.ENV_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  }

  if (Object.keys(generated).length > 0) {
    upsertEnvValues(envPath, generated);
    for (const [key, value] of Object.entries(generated)) {
      process.env[key] = value;
    }
    console.log(`[korrelo-api] Gerou automaticamente: ${Object.keys(generated).join(", ")} (salvo em ${envPath})`);
  }

  restrictEnvFilePermissions(envPath);
}

/**
 * Aperta a permissão do .env pra 0600. Roda sempre (não só quando acabou
 * de gerar algo) porque um arquivo criado pelo instalador ou copiado
 * manualmente pode ter ficado com 0644.
 */
function restrictEnvFilePermissions(envPath: string): void {
  try {
    if (!fs.existsSync(envPath)) return;
    fs.chmodSync(envPath, ENV_FILE_MODE);
  } catch (error) {
    // Não impede a API de subir: só avisa. Sem permissão de escrita no
    // arquivo (caso raro), seguir com a permissão atual é melhor que
    // derrubar a instalação.
    console.warn(
      `[korrelo-api] Não foi possível ajustar a permissão do arquivo de ambiente: ${(error as Error).message}`,
    );
  }
}
