import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSelfUpdateRunning, selfUpdateLockPath } from "./self-update-state";

/**
 * O deploy consulta o lock do self-update no momento da limpeza. Estes testes
 * travam a leitura:
 * - ausência de lock => livre;
 * - lock de processo VIVO => self-update em andamento (limpeza recusada);
 * - lock órfão (PID morto) => livre;
 * - arquivo ilegível => conservador (self-update em andamento);
 * - o caminho padrão é o MESMO usado pelo rollout (~/.korrelo/self-update.lock).
 */
describe("self-update-state", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-self-update-state-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.KORRELO_SELF_UPDATE_LOCK;
  });

  it("sem arquivo de lock: self-update NÃO está em andamento", () => {
    expect(isSelfUpdateRunning(path.join(dir, "nao-existe.lock"))).toBe(false);
  });

  it("lock com PID vivo: self-update em andamento", () => {
    const lockPath = path.join(dir, "self-update.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));

    expect(isSelfUpdateRunning(lockPath)).toBe(true);
  });

  it("lock órfão (PID inexistente): liberado", () => {
    const lockPath = path.join(dir, "self-update.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }));

    expect(isSelfUpdateRunning(lockPath)).toBe(false);
  });

  it("lock ilegível: conservador (assume em andamento)", () => {
    const lockPath = path.join(dir, "self-update.lock");
    fs.writeFileSync(lockPath, "conteudo-invalido");

    expect(isSelfUpdateRunning(lockPath)).toBe(true);
  });

  it("caminho padrão é o mesmo do rollout (~/.korrelo/self-update.lock)", () => {
    expect(selfUpdateLockPath()).toMatch(/[\\/]\.korrelo[\\/]self-update\.lock$/);
  });

  it("override de teste é respeitado", () => {
    const custom = path.join(dir, "custom.lock");
    process.env.KORRELO_SELF_UPDATE_LOCK = custom;

    expect(selfUpdateLockPath()).toBe(custom);
  });
});
