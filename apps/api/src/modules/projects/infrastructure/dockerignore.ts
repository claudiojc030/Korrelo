import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Entradas OBRIGATÓRIAS no .dockerignore de todo projeto.
 *
 * Motivo (achado DEP-06 da auditoria): quando o projeto traz o próprio
 * Dockerfile, o Korrelo não gerava .dockerignore - e um "COPY . ." do
 * projeto copiava pro contexto (e pra imagem) o arquivo de ambiente do
 * Korrelo (.env.korrelo) e o compose do projeto (que tem a SENHA do banco
 * em texto puro).
 *
 * Mesmo com o arquivo de ambiente fora do contexto (decisão da Wave 2),
 * estas entradas continuam obrigatórias: a garantia não pode depender de
 * um único mecanismo.
 */
export const REQUIRED_DOCKERIGNORE_ENTRIES = [
  ".env.korrelo",
  "docker-compose.korrelo.yml",
  // Composes POR JOB e a cópia da configuração anterior (nunca entram no
  // contexto de build; carregam porta/senha de banco em texto puro).
  "docker-compose.korrelo.*.yml",
  // Arquivo temporário usado no rename atômico do compose estável.
  ".docker-compose.korrelo.yml.tmp",
  "docker-compose.korrelo.previous.yml.tmp",
  ".env",
  ".env.*",
];

/**
 * Entradas usadas quando o Korrelo CRIA o .dockerignore (projeto sem o
 * arquivo). Menos é mais: o .dockerignore do dono do projeto é preservado.
 */
export const GENERATED_DOCKERIGNORE_ENTRIES = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "*.log",
  ...REQUIRED_DOCKERIGNORE_ENTRIES,
];

function normalizeEntry(entry: string): string {
  return entry.trim().replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Junta as entradas obrigatórias no .dockerignore existente SEM apagar o
 * que o dono do projeto colocou e sem duplicar linha.
 */
export function mergeDockerignore(existing: string | null, required: string[]): {
  content: string;
  added: string[];
} {
  const currentLines = (existing ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const present = new Set(currentLines.map(normalizeEntry));
  const added: string[] = [];

  for (const entry of required) {
    const normalized = normalizeEntry(entry);
    if (present.has(normalized)) continue;
    present.add(normalized);
    added.push(entry);
  }

  // Comentários do usuário são preservados: o conteúdo original só recebe
  // as entradas novas no final.
  const original = (existing ?? "").trimEnd();
  const content = original.length > 0 ? `${original}\n${added.join("\n")}\n` : `${added.join("\n")}\n`;
  return { content, added };
}

/**
 * Garante que o projeto tenha um .dockerignore com as entradas obrigatórias.
 * Não sobrescreve o arquivo do usuário: só acrescenta o que falta.
 */
export async function ensureDockerignore(
  projectPath: string,
  required: string[] = REQUIRED_DOCKERIGNORE_ENTRIES,
): Promise<{ changed: boolean; added: string[] }> {
  const filePath = path.join(projectPath, ".dockerignore");
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    existing = null;
  }

  const { content, added } = mergeDockerignore(existing, required);
  if (existing !== null && added.length === 0) {
    return { changed: false, added: [] };
  }

  await fs.writeFile(filePath, content, "utf-8");
  return { changed: true, added };
}
