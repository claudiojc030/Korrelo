"use client";

/**
 * DISMISS DO MODAL DE SELF-UPDATE (por job).
 *
 * O problema: o self-update termina com sucesso, o operador clica em
 * "Recarregar painel" e a página recarrega - o SelfUpdateWatcher encontra
 * o job terminal recente (<10 min) e REABRE o modal. O operador fica
 * preso vendo o mesmo modal repetidamente.
 *
 * A lógica não distingia:
 *  1. refresh/reconexão involuntária enquanto o update AINDA estava
 *     acontecendo (aqui o modal DEVE reabrir);
 *  2. usuário que já viu o resultado e clicou em "Fechar" ou "Recarregar
 *     painel" (aqui o modal NÃO deve reabrir).
 *
 * A solução: o operador dispensa o job explicitamente e o dismiss é
 * lembrado pelo ID do job. Um dismiss NUNCA esconde um job futuro (o ID
 * é diferente).
 *
 * `sessionStorage` (e não `localStorage`): o dismiss vale para a sessão do
 * navegador - fechar a aba e voltar de novo mostra o estado final de novo,
 * que é o comportamento esperado.
 */

const KEY_PREFIX = "korrelo:self-update:dismissed:";

function storage(): Storage | null {
  // SSR / ambiente sem DOM: sem dismiss (e sem quebrar).
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Navegador com storage bloqueado (privacidade): segue sem dismiss.
    return null;
  }
}

/** Marca o job como "já visto e dispensado". */
export function dismissSelfUpdateJob(jobId: string | null | undefined): void {
  if (!jobId) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${KEY_PREFIX}${jobId}`, "1");
  } catch {
    /* quota/erro: seguir sem dismiss */
  }
}

/** O job foi dispensado pelo operador? */
export function isSelfUpdateJobDismissed(jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(`${KEY_PREFIX}${jobId}`) === "1";
  } catch {
    return false;
  }
}

/** Só para teste: limpa os dismisses da sessão. */
export function clearDismissedSelfUpdateJobs(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    /* ignora */
  }
}
