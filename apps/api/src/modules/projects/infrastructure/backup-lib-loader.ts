import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * CARREGADOR DA LIB DE BACKUP (CJS) PRA DENTRO DO TypeScript.
 *
 * O motor de dump/restore vive em `scripts/backup-lib/*.cjs` porque é
 * compartilhado por três consumidores que rodam em Node puro:
 * - o cron (apps/api/scripts/backup.js);
 * - os wrappers bash (scripts/export-database.sh, scripts/restore-database.sh);
 * - a suíte de testes da API.
 *
 * `createRequire` carrega o .cjs sem precisar de `allowJs` no tsconfig
 * (e sem mexer no rootDir da compilação).
 */
const requireCjs = createRequire(__filename);

/** Diretório da lib de backup (mesmo caminho em src/ e em dist/). */
export const BACKUP_LIB_DIR = path.resolve(__dirname, "../../../../../../scripts/backup-lib");

/** Carrega um módulo da lib de backup. */
export function loadBackupLib<T = Record<string, unknown>>(fileName: string): T {
  return requireCjs(path.join(BACKUP_LIB_DIR, fileName)) as T;
}
