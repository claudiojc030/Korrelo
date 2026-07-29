import * as crypto from "node:crypto";
import * as path from "node:path";
import { upsertEnvValues } from "./env-file";

// Rede de segurança pra JWT_SECRET e ENV_ENCRYPTION_KEY: o instalador
// (scripts/setup-vps.sh) já gera os dois na primeira instalação, mas essa
// checagem garante que ISSO SEMPRE ACONTECE pra qualquer forma de rodar a
// API (setup manual, docker, um instalador futuro que esqueça de gerar),
// em vez de depender só do script shell não falhar. Sem uma dessas chaves,
// sessões não autenticam e env vars de projeto não conseguem ser cifradas.
export function ensureRequiredSecrets(): void {
  const envPath = path.join(process.cwd(), ".env");
  const generated: Record<string, string> = {};

  if (!process.env.JWT_SECRET) {
    generated.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  }
  if (!process.env.ENV_ENCRYPTION_KEY) {
    generated.ENV_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  }

  if (Object.keys(generated).length === 0) {
    return;
  }

  upsertEnvValues(envPath, generated);
  for (const [key, value] of Object.entries(generated)) {
    process.env[key] = value;
  }
  console.log(`[korrelo-api] Gerou automaticamente: ${Object.keys(generated).join(", ")} (salvo em ${envPath})`);
}
