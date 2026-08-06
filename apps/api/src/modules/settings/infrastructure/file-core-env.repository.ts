import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { upsertEnvValues } from "../../../infrastructure/env-file";
import type { CoreEnvRepository, CoreEnvVar } from "../domain/core-env.repository";

const ENV_LINE_PATTERN = /^([A-Z0-9_]+)=(.*)$/;

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

  async upsertOne(key: string, value: string): Promise<void> {
    upsertEnvValues(this.envPath, { [key]: value });
  }

  async upsertMany(values: Record<string, string>): Promise<void> {
    upsertEnvValues(this.envPath, values);
  }
}
