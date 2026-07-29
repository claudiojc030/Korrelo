import { BadRequestException } from "@nestjs/common";
import * as path from "node:path";
import { apiError } from "../../../infrastructure/api-error";

// Arquivos que o Korrelo gera e que guardam segredo ou config interna.
// Nunca ficam navegáveis/editáveis por aqui, mesmo que o usuário peça o
// caminho exato.
const BLOCKED_SEGMENTS = [".git", ".env.korrelo", "docker-compose.korrelo.yml"];

// Resolve um caminho relativo pedido pelo cliente contra a raiz do workspace
// do projeto, garantindo que o resultado nunca escapa dessa raiz (proteção
// contra path traversal via "../") e que não toca em arquivos bloqueados.
export function resolveSafeProjectPath(workspaceRoot: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/^\/+/, "");
  const resolved = path.resolve(workspaceRoot, normalizedRelative);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;

  if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
    throw new BadRequestException(apiError("INVALID_PATH", "Caminho inválido."));
  }

  const segments = normalizedRelative.split(/[\\/]/);
  if (segments.some((segment) => BLOCKED_SEGMENTS.includes(segment))) {
    throw new BadRequestException(apiError("FILE_PATH_BLOCKED", "Esse arquivo não pode ser acessado por aqui."));
  }

  return resolved;
}
