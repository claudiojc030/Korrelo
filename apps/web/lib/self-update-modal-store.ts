"use client";

import { useSyncExternalStore } from "react";

/**
 * ESTADO DO MODAL DE SELF-UPDATE (store simples, fora do React).
 *
 * O modal pode ser aberto por dois caminhos:
 * - o operador clicando em "Atualizar agora" (UpdateBanner);
 * - a página recarregou no meio de um update em andamento (SelfUpdateWatcher).
 *
 * Sem um dono único, os dois abririam um modal cada (dois overlays, dois
 * pollings, confusão). Este store é o dono único: abrir de novo apenas
 * troca o jobId.
 *
 * É um store simples (subscribe/getSnapshot) porque o Next.js App Router
 * renderiza a página no servidor: um Provider exigiria envolver a página
 * inteira, e o watcher já vive dentro dela.
 */
export interface SelfUpdateModalState {
  /** Job do self-update em acompanhamento (null = nenhum). */
  jobId: string | undefined;
  /** O modal está aberto? */
  open: boolean;
}

let state: SelfUpdateModalState = { jobId: undefined, open: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export const selfUpdateModalStore = {
  getState(): SelfUpdateModalState {
    return state;
  },
  /** Abre (ou re-abre, trocando o job) o modal de acompanhamento. */
  show(jobId?: string): void {
    state = { jobId, open: true };
    emit();
  },
  /** Fecha o modal. */
  hide(): void {
    state = { ...state, open: false };
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Hook React para ler o store. */
export function useSelfUpdateModal(): SelfUpdateModalState & {
  show: (jobId?: string) => void;
  hide: () => void;
} {
  const snapshot = useSyncExternalStore(
    selfUpdateModalStore.subscribe,
    selfUpdateModalStore.getState,
    selfUpdateModalStore.getState,
  );
  return {
    ...snapshot,
    show: selfUpdateModalStore.show,
    hide: selfUpdateModalStore.hide,
  };
}
