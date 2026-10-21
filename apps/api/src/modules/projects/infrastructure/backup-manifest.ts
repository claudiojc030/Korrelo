import { promises as fs } from "node:fs";

/**
 * MANIFESTO DE BACKUP (lado TypeScript).
 *
 * O manifesto é gravado pelo motor de dump (scripts/backup-lib/backup-file.cjs)
 * ao lado do arquivo de backup: `<arquivo>.manifest.json`.
 *
 * Ele existe pra responder a UMA pergunta: "esse arquivo é um backup
 * completo e íntegro?". Sem manifesto (backup legado, feito antes
 * desta wave) o arquivo continua visível, mas marcado como NÃO
 * validado - nunca some da lista, nunca é apagado.
 *
 * IMPORTANTE: o manifesto NUNCA guarda segredo (sem senha, sem URI, sem
 * token) - só metadados do backup.
 */
export interface BackupManifest {
  version: number;
  projectId: string | null;
  dbType: string;
  serviceName: string | null;
  containerName: string | null;
  reason: string;
  createdAt: string;
  fileName: string;
  bytes: number;
  sha256: string;
  status: string;
  format: string;
}

export type BackupState = "complete" | "legacy" | "incomplete";

export interface BackupStateInfo {
  /** "complete": manifesto ok. "legacy": sem manifesto (não validado). "incomplete": marcado como incompleto. */
  state: BackupState;
  manifest: BackupManifest | null;
  /** true só quando existe manifesto com status "complete". */
  validated: boolean;
}

export const MANIFEST_SUFFIX = ".manifest.json";

/** Caminho do manifesto ao lado de um backup. */
export function manifestPathFor(filePath: string): string {
  return `${filePath}${MANIFEST_SUFFIX}`;
}

/** O nome do arquivo parece um dump em andamento (.tmp-<jobId>)? */
export function isTempBackupName(fileName: string): boolean {
  return /\.tmp-[A-Za-z0-9_-]+/.test(fileName);
}

/** Lê o manifesto de um backup (null se não existir/corrompido). */
export async function readBackupManifest(filePath: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.readFile(manifestPathFor(filePath), "utf-8");
    const parsed = JSON.parse(raw) as BackupManifest;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Estado de um backup a partir do manifesto.
 *
 * - "complete":   manifesto presente e status "complete" (checksum conferido na criação)
 * - "legacy":     backup antigo sem manifesto - visível, mas NÃO validado
 * - "incomplete": marcado como incompleto - não pode ser listado/baixado/restaurado
 */
export async function readBackupState(filePath: string): Promise<BackupStateInfo> {
  const manifest = await readBackupManifest(filePath);
  if (!manifest) {
    return { state: "legacy", manifest: null, validated: false };
  }
  if (manifest.status !== "complete") {
    return { state: "incomplete", manifest, validated: false };
  }
  return { state: "complete", manifest, validated: true };
}
