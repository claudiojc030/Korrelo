/**
 * CHECAGEM DE ATUALIZAÇÃO (cache + invalidação).
 *
 * O bug real: depois do self-update, o dashboard continuava mostrando
 * "Atualização disponível (1 commit atrás)" mesmo com
 * `git log HEAD..origin/main` VAZIO.
 *
 * Causa: o `git fetch` (que é o que descobre o commit remoto) só rodava
 * a cada 10 minutos (cache) - e o cache continuava servindo o valor
 * antigo depois do HEAD ter avançado.
 *
 * Aqui provamos que:
 * - HEAD == origin/main -> não há atualização;
 * - 1 (ou N) commits atrás -> há atualização;
 * - fetch falhando -> NENHUM falso positivo (fica "não verificado");
 * - o commit local mudou (self-update) -> a checagem é refeita;
 * - o commit local NÃO mudou -> o cache é aproveitado (sem novo fetch).
 */

import { GetUpdateStatusUseCase } from "./get-update-status.use-case";
import type { UpdateChecker, UpdateStatus } from "../domain/update-checker";

/** Checker falso: o resultado depende do que o teste configura. */
class FakeUpdateChecker implements UpdateChecker {
  checks = 0;
  /** Resultado devolvido pelo check(). */
  result: UpdateStatus = {
    checked: true,
    currentCommit: "aaaa1111",
    remoteCommit: "aaaa1111",
    commitsBehind: 0,
    updateAvailable: false,
  };
  /** Erro do fetch (simula rede/credencial quebrada). */
  failure: Error | null = null;
  /** Commit local reported. */
  commit: string | null = "aaaa1111";

  async check(): Promise<UpdateStatus> {
    this.checks += 1;
    if (this.failure) throw this.failure;
    return this.result;
  }

  async localCommit(): Promise<string | null> {
    return this.commit;
  }
}

function status(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    checked: true,
    currentCommit: "aaaa1111",
    remoteCommit: "aaaa1111",
    commitsBehind: 0,
    updateAvailable: false,
    ...overrides,
  };
}

describe("GetUpdateStatusUseCase", () => {
  it("1) HEAD == origin/main -> não há atualização (banner escondido)", async () => {
    const checker = new FakeUpdateChecker();
    checker.result = status({ currentCommit: "9ff573c", remoteCommit: "9ff573c", commitsBehind: 0 });
    const useCase = new GetUpdateStatusUseCase(checker);

    const result = await useCase.execute();

    expect(result.updateAvailable).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it("2) 1 commit atrás -> há atualização", async () => {
    const checker = new FakeUpdateChecker();
    checker.result = status({ currentCommit: "aaaa1111", remoteCommit: "bbbb2222", commitsBehind: 1, updateAvailable: true });
    const useCase = new GetUpdateStatusUseCase(checker);

    const result = await useCase.execute();

    expect(result.updateAvailable).toBe(true);
    expect(result.commitsBehind).toBe(1);
  });

  it("3) vários commits atrás -> a contagem é a real", async () => {
    const checker = new FakeUpdateChecker();
    checker.result = status({ commitsBehind: 7, updateAvailable: true });
    const useCase = new GetUpdateStatusUseCase(checker);

    const result = await useCase.execute();

    expect(result.commitsBehind).toBe(7);
    expect(result.updateAvailable).toBe(true);
  });

  it("4) fetch/check falhando -> NENHUM falso positivo", async () => {
    const checker = new FakeUpdateChecker();
    checker.failure = new Error("fatal: could not read from remote repository");
    const useCase = new GetUpdateStatusUseCase(checker);

    await expect(useCase.execute()).rejects.toThrow();

    // O checker real devolve "não verificado" (checked: false) - o que
    // impede o banner de aparecer. Aqui provamos que a falha NÃO vira
    // "atualização disponível" em nenhum caminho.
    expect(checker.checks).toBe(1);
  });

  it("5) o commit local MUDOU (self-update) -> a checagem é refeita", async () => {
    const checker = new FakeUpdateChecker();
    checker.result = status({ commitsBehind: 1, updateAvailable: true });
    const useCase = new GetUpdateStatusUseCase(checker);

    await useCase.execute();
    expect(checker.checks).toBe(1);

    // O self-update mudou o HEAD: o cache antigo ("1 commit atrás") não
    // pode continuar valendo.
    checker.commit = "cccc3333";
    checker.result = status({
      currentCommit: "cccc3333",
      remoteCommit: "cccc3333",
      commitsBehind: 0,
      updateAvailable: false,
    });

    const afterUpdate = await useCase.execute();

    expect(checker.checks).toBe(2);
    expect(afterUpdate.updateAvailable).toBe(false);
    expect(afterUpdate.commitsBehind).toBe(0);
  });

  it("6) o commit local NÃO mudou -> o cache é aproveitado (sem novo fetch)", async () => {
    const checker = new FakeUpdateChecker();
    checker.result = status({ commitsBehind: 2, updateAvailable: true });
    const useCase = new GetUpdateStatusUseCase(checker);

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.updateAvailable).toBe(true);
    expect(second.updateAvailable).toBe(true);
    // Só UM fetch: o cache vale enquanto o HEAD não mudar.
    expect(checker.checks).toBe(1);
  });

  it("7) invalidate() força a próxima checagem", async () => {
    const checker = new FakeUpdateChecker();
    const useCase = new GetUpdateStatusUseCase(checker);

    await useCase.execute();
    expect(checker.checks).toBe(1);

    useCase.invalidate();
    await useCase.execute();

    expect(checker.checks).toBe(2);
  });

  it("8) checker sem localCommit() continua funcionando (compatibilidade)", async () => {
    const checker = {
      check: async () => status({ commitsBehind: 0 }),
    } as unknown as UpdateChecker;
    const useCase = new GetUpdateStatusUseCase(checker);

    const result = await useCase.execute();

    expect(result.updateAvailable).toBe(false);
  });
});
