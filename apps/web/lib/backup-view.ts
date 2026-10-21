/**
 * REGRAS DE BACKUP NO PAINEL (lógica pura, testável).
 *
 * Um backup "legado" é um backup feito ANTES dos backups terem manifesto
 * (sem checksum, sem status). Ele continua existindo e pode ser
 * restaurado - mas a integridade dele não pode ser confirmada
 * automaticamente. Por isso o restore de um backup legado exige uma
 * confirmação EXTRA: o operador precisa saber que está restaurando um
 * arquivo que ninguém verificou.
 */

export interface BackupViewEntry {
  id: string;
  createdAt: string;
  dbType: "postgres" | "mongodb" | "redis";
  fileName: string;
  sizeBytes: number;
  /** true quando o backup tem manifesto com checksum conferido na criação. */
  validated?: boolean;
  /** true quando é um backup antigo, sem manifesto/checksum. */
  legacy?: boolean;
}

/** Backup legado (sem checksum) exige confirmação extra antes de restaurar. */
export function requiresLegacyConfirmation(backup: BackupViewEntry): boolean {
  return backup.legacy === true;
}

/**
 * O restore pode começar?
 * - backup validado: sempre ✓
 * - backup legado: só depois da confirmação extra ✓
 */
export function canStartRestore(backup: BackupViewEntry, legacyConfirmed: boolean): boolean {
  if (requiresLegacyConfirmation(backup)) return legacyConfirmed === true;
  return true;
}
