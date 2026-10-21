import {
  canStartRestore,
  requiresLegacyConfirmation,
  type BackupViewEntry,
} from "../lib/backup-view";
import { projectDatabaseEn } from "../lib/i18n/dictionaries/project-database";
import { projectDatabasePt } from "../lib/i18n/dictionaries/project-database";

/**
 * BACKUP LEGADO NO PAINEL.
 *
 * Backup "legado" = feito antes dos backups terem manifesto/checksum.
 * Ele continua disponível para restore, mas a integridade não pode ser
 * confirmada -> o painel exige uma CONFIRMAÇÃO EXTRA antes de restaurar.
 */
describe("regras de backup legado no painel", () => {
  const base: BackupViewEntry = {
    id: "2026-10-01T03-00-00-000Z",
    createdAt: "2026-10-01T03:00:00.000Z",
    dbType: "mongodb",
    fileName: "meu-projeto-mongodb.archive",
    sizeBytes: 1024,
  };

  it("backup legado exige confirmação extra", () => {
    const backup: BackupViewEntry = { ...base, legacy: true, validated: false };

    expect(requiresLegacyConfirmation(backup)).toBe(true);
    // Sem a confirmação, o restore não pode começar.
    expect(canStartRestore(backup, false)).toBe(false);
    // Com a confirmação, pode.
    expect(canStartRestore(backup, true)).toBe(true);
  });

  it("backup validado não exige confirmação extra", () => {
    const backup: BackupViewEntry = { ...base, legacy: false, validated: true };

    expect(requiresLegacyConfirmation(backup)).toBe(false);
    expect(canStartRestore(backup, false)).toBe(true);
    expect(canStartRestore(backup, true)).toBe(true);
  });

  it("backup sem informação de legado (resposta antiga da API) pode ser restaurado", () => {
    expect(requiresLegacyConfirmation(base)).toBe(false);
    expect(canStartRestore(base, false)).toBe(true);
  });

  it("as traduções do aviso existem em pt e en", () => {
    for (const dict of [projectDatabasePt, projectDatabaseEn]) {
      expect(dict.restoreLegacyWarning.length).toBeGreaterThan(10);
      expect(dict.restoreLegacyConfirmLabel.length).toBeGreaterThan(10);
      expect(dict.backupLegacyBadge.length).toBeGreaterThan(0);
      expect(dict.backupLegacyHint.length).toBeGreaterThan(0);
    }
    // pt e en não podem ser a mesma string.
    expect(projectDatabasePt.restoreLegacyWarning).not.toBe(projectDatabaseEn.restoreLegacyWarning);
    expect(projectDatabasePt.restoreLegacyConfirmLabel).not.toBe(projectDatabaseEn.restoreLegacyConfirmLabel);
  });
});
