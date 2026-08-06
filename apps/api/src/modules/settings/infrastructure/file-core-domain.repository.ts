import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreDomainRepository } from "../domain/core-domain-repository";

// Estado simples num arquivo JSON (mesmo diretório ~/.korrelo usado pelo
// self-updater), não precisa de tabela no banco pra um único valor.
@Injectable()
export class FileCoreDomainRepository implements CoreDomainRepository {
  private get filePath(): string {
    return path.join(os.homedir(), ".korrelo", "core-settings.json");
  }

  async get(): Promise<string | null> {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return typeof data.domain === "string" ? data.domain : null;
    } catch {
      return null;
    }
  }

  async set(domain: string | null): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ domain }));
  }
}
