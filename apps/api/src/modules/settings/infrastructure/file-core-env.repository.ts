import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { upsertEnvValues } from "../../../infrastructure/env-file";
import type { CoreEnvRepository, CoreEnvVar } from "../domain/core-env.repository";

const ENV_LINE_PATTERN = /^([A-Z0-9_]+)=(.*)$/;

/**
 * Permissão do arquivo de ambiente do Core. O arquivo guarda JWT_SECRET,
 * ENV_ENCRYPTION_KEY e a chave privada do GitHub App: 0600 (só o dono lê).
 */
const ENV_FILE_MODE = 0o600;

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

@Injectable()
export class FileCoreEnvRepository implements CoreEnvRepository {
  private readonly logger = new Logger(FileCoreEnvRepository.name);

  // O processo da API sempre roda com cwd em apps/api (ver ecosystem.config.js
  // e ScriptSelfUpdater), então o .env do Core está sempre um nível acima daqui.
  private get envPath(): string {
    return path.resolve(process.cwd(), ".env");
  }

  async list(): Promise<CoreEnvVar[]> {
    if (!fs.existsSync(this.envPath)) return [];
    const lines = fs.readFileSync(this.envPath, "utf-8").split("\n");
    const vars: CoreEnvVar[] = [];
    for (const line of lines) {
      const match = line.match(ENV_LINE_PATTERN);
      if (match) {
        vars.push({ key: match[1], value: stripQuotes(match[2]) });
      }
    }
    return vars;
  }

  async getValue(key: string): Promise<string | null> {
    const vars = await this.list();
    return vars.find((variable) => variable.key === key)?.value ?? null;
  }

  async upsertOne(key: string, value: string): Promise<void> {
    upsertEnvValues(this.envPath, { [key]: value });
    this.restrictPermissions();
  }

  async upsertMany(values: Record<string, string>): Promise<void> {
    upsertEnvValues(this.envPath, values);
    this.restrictPermissions();
  }

  /**
   * Garante 0600 no .env. Se o arquivo já existe com permissão mais aberta
   * (install antigo, cópia manual), a gravação pela tela de Configurações
   * passa a apertar a permissão - sem falhar a operação.
   */
  private restrictPermissions(): void {
    try {
      if (!fs.existsSync(this.envPath)) return;
      fs.chmodSync(this.envPath, ENV_FILE_MODE);
    } catch (error) {
      this.logger.warn(
        `Não foi possível ajustar a permissão do arquivo de ambiente: ${(error as Error).message}`,
      );
    }
  }
}
