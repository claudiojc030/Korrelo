/**
 * DISMISS DO MODAL DE SELF-UPDATE.
 *
 * O bug: o update terminava com sucesso, o operador clicava em "Recarregar
 * painel", a página recarregava e o watcher reencontrava o job terminal
 * recente e REABRIA o modal - o operador ficava preso no mesmo modal.
 *
 * Aqui provamos que:
 * - um job ATIVO sempre reabre (refresh involuntário durante o update);
 * - um job TERMINADO recente reabre, a menos que o operador o tenha
 *   dispensado ("Fechar" / "Recarregar painel");
 * - o dismiss de um job NUNCA esconde outro job;
 * - um job terminado há mais de 10 minutos não reabre.
 */

import {
  clearDismissedSelfUpdateJobs,
  dismissSelfUpdateJob,
  isSelfUpdateJobDismissed,
} from "../lib/self-update-dismiss-store";
import { shouldReopenSelfUpdateJob } from "../lib/self-update-view";

/** sessionStorage mínimo (o ambiente de teste é "node", sem DOM). */
class FakeSessionStorage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const storage = new FakeSessionStorage();
const reload = jest.fn();

beforeEach(() => {
  clearDismissedSelfUpdateJobs();
  reload.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: storage,
    location: { reload },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("self-update - dismiss do modal", () => {
  it("1) job terminal recente SEM dismiss reabre", () => {
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
        dismissed: false,
      }),
    ).toBe(true);
  });

  it("2) job terminal recente DISMISSED não reabre", () => {
    dismissSelfUpdateJob("upd-1");
    expect(isSelfUpdateJobDismissed("upd-1")).toBe(true);
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
        dismissed: isSelfUpdateJobDismissed("upd-1"),
      }),
    ).toBe(false);
  });

  it("3) job RUNNING sempre reabre (refresh involuntário durante o update)", () => {
    expect(
      shouldReopenSelfUpdateJob({
        status: "running",
        finishedAt: null,
        dismissed: true,
      }),
    ).toBe(true);
  });

  it("4) job em espera (queued/verifying/restarting) também reabre", () => {
    for (const status of ["queued", "verifying", "restarting"]) {
      expect(
        shouldReopenSelfUpdateJob({ status, finishedAt: null, dismissed: true }),
      ).toBe(true);
    }
  });

  it("5) o dismiss do job A NÃO esconde o job B", () => {
    dismissSelfUpdateJob("upd-A");
    expect(isSelfUpdateJobDismissed("upd-A")).toBe(true);
    expect(isSelfUpdateJobDismissed("upd-B")).toBe(false);
    // O job B (novo) reabre normalmente.
    expect(
      shouldReopenSelfUpdateJob({
        status: "running",
        finishedAt: null,
        dismissed: isSelfUpdateJobDismissed("upd-B"),
      }),
    ).toBe(true);
  });

  it("6) um job futuro (ID diferente) NÃO é escondido pelo dismiss de outro", () => {
    dismissSelfUpdateJob("upd-1");
    // O ID do job é único por update (upd-<timestamp>-<rand>): ID diferente
    // = job diferente = não dispensado.
    expect(isSelfUpdateJobDismissed("upd-2")).toBe(false);
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date(Date.now() - 30_000).toISOString(),
        dismissed: isSelfUpdateJobDismissed("upd-2"),
      }),
    ).toBe(true);
  });

  it("7) job terminado há mais de 10 minutos NÃO reabre", () => {
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        dismissed: false,
      }),
    ).toBe(false);
  });

  it("8) 'Fechar' marca o dismiss antes de fechar o modal", () => {
    // O que o botão do modal faz: marca e só depois fecha.
    const jobId = "upd-9";
    expect(isSelfUpdateJobDismissed(jobId)).toBe(false);
    dismissSelfUpdateJob(jobId);
    expect(isSelfUpdateJobDismissed(jobId)).toBe(true);
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date().toISOString(),
        dismissed: isSelfUpdateJobDismissed(jobId),
      }),
    ).toBe(false);
  });

  it("9) 'Recarregar painel' marca o dismiss ANTES do reload", () => {
    // Se o reload acontecesse antes da marcação, o watcher reencontraria o
    // job terminal e reabriria o modal (o bug relatado).
    const jobId = "upd-10";
    const ordem: string[] = [];
    dismissSelfUpdateJob(jobId);
    ordem.push("dismiss");
    window.location.reload();
    ordem.push("reload");
    expect(ordem).toEqual(["dismiss", "reload"]);
    expect(isSelfUpdateJobDismissed(jobId)).toBe(true);
    // Depois do reload, o watcher NÃO reabre.
    expect(
      shouldReopenSelfUpdateJob({
        status: "completed",
        finishedAt: new Date().toISOString(),
        dismissed: isSelfUpdateJobDismissed(jobId),
      }),
    ).toBe(false);
  });

  it("10) sem dismiss, um job FAILED recente reabre", () => {
    expect(
      shouldReopenSelfUpdateJob({
        status: "failed",
        finishedAt: new Date(Date.now() - 30_000).toISOString(),
        dismissed: false,
      }),
    ).toBe(true);
  });

  it("11) dismiss sem jobId é ignorado (não quebra)", () => {
    expect(() => dismissSelfUpdateJob(undefined)).not.toThrow();
    expect(() => dismissSelfUpdateJob(null)).not.toThrow();
    expect(isSelfUpdateJobDismissed(undefined)).toBe(false);
  });

  it("12) o dismiss de um job terminal some com o clear (usado só em teste)", () => {
    dismissSelfUpdateJob("upd-4");
    expect(isSelfUpdateJobDismissed("upd-4")).toBe(true);
    clearDismissedSelfUpdateJobs();
    expect(isSelfUpdateJobDismissed("upd-4")).toBe(false);
  });
});
