/**
 * ESTADO DO SELF-UPDATE (somente leitura).
 *
 * O deploy de projeto precisa saber, NO MOMENTO DA LIMPEZA, se um
 * self-update/rollout do Core está em andamento.
 *
 * FONTE DA VERDADE: o MESMO lock usado pelo rollout
 * (`apps/api/scripts/rollout/lib/self-update-lock.cjs`), no MESMO caminho
 * efetivo (`defaultLockPath()` = ~/.korrelo/self-update.lock). O caminho é
 * obtido da própria biblioteca oficial para nunca divergir do rollout.
 *
 * POR QUE NÃO IMPORTAR O MÓDULO DE MONITORING:
 * o MonitoringModule já importa o ProjectsModule (para a fila de deploy).
 * Importar de volta criaria ciclo de módulos no Nest.
 *
 * REGRA CONSERVADORA: se o arquivo existe mas não dá para decidir, assume que
 * o self-update está ATIVO (a limpeza é recusada). Nunca o contrário.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SelfUpdateLockLib {
  readLock: (lockPath: string) => { pid?: number } | null;
  isOrphaned: (lockPath: string, now?: number, timeoutMs?: number) => boolean;
  defaultLockPath: (home?: string) => string;
}

let cachedLib: SelfUpdateLockLib | null | undefined;

/**
 * Carrega a biblioteca oficial do lock sob demanda.
 *
 * Sob demanda (e não no topo do módulo) porque este arquivo é importado pelo
 * caminho de deploy: se a lib sumisse de uma instalação quebrada, o Core NÃO
 * deve deixar de subir - apenas a limpeza fica conservadora (recusada).
 */
function loadLockLib(): SelfUpdateLockLib | null {
  if (cachedLib !== undefined) return cachedLib;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedLib = require("../../scripts/rollout/lib/self-update-lock.cjs") as SelfUpdateLockLib;
  } catch {
    cachedLib = null;
  }
  return cachedLib;
}

export interface SelfUpdateStateLike {
  /** true quando um rollout do Core está em andamento (lock vivo). */
  isRunning(): boolean;
}

/**
 * Caminho efetivo do lock, IGUAL ao usado pelo rollout.
 *
 * `KORRELO_SELF_UPDATE_LOCK` existe só para testes (o rollout não o lê).
 */
export function selfUpdateLockPath(): string {
  if (process.env.KORRELO_SELF_UPDATE_LOCK) return process.env.KORRELO_SELF_UPDATE_LOCK;
  const lib = loadLockLib();
  if (lib) return lib.defaultLockPath();
  // Fallback idêntico ao defaultLockPath() da lib oficial.
  return path.join(os.homedir(), ".korrelo", "self-update.lock");
}

/** Leitura pura do lock oficial. Nunca cria, altera ou remove o arquivo. */
export function isSelfUpdateRunning(lockPath: string = selfUpdateLockPath()): boolean {
  try {
    if (!fs.existsSync(lockPath)) return false;
    const lib = loadLockLib();
    if (!lib) return true; // sem a lib oficial: conservador
    const lock = lib.readLock(lockPath);
    if (!lock) return true; // existe mas ilegível: conservador
    if (lib.isOrphaned(lockPath)) return false; // pid morto ou expirado
    return true;
  } catch {
    return true; // conservador: na dúvida, não limpa
  }
}

export const defaultSelfUpdateState: SelfUpdateStateLike = {
  isRunning: () => isSelfUpdateRunning(),
};
