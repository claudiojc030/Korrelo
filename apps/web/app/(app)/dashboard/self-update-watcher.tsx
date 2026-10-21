"use client";

import { useEffect } from "react";
import { apiFetch, isAuthFailure } from "../../../lib/api-client";
import { useSelfUpdateModal } from "../../../lib/self-update-modal-store";
import { isActiveStatus, isTerminalStatus } from "../../../lib/self-update-view";
import { UpdateProgressModal } from "./update-progress-modal";

/**
 * RECONEXÃO / REFRESH DO SELF-UPDATE.
 *
 * O self-update roda num processo DETACHED: ele sobrevive ao reload da
 * página. Então, se o operador recarregar a página (ou o Web reiniciar)
 * no meio da atualização, o modal tem que REABRIR sozinho mostrando o
 * progresso atual - e não sumir.
 *
 * A fonte de verdade é o job persistido
 * (~/.korrelo/self-update/current.json -> <id>.json), que a API já expõe em
 * GET /monitoring/self-update/current. Nenhuma segunda fonte de estado é
 * criada aqui.
 *
 * Se o update JÁ TERMINOU enquanto a página estava fora, o modal abre
 * mostrando o estado final (SUCCESS/FAILED) e o operador pode fechá-lo.
 */
export function SelfUpdateWatcher() {
  const { jobId, open, show, hide } = useSelfUpdateModal();

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await apiFetch("/monitoring/self-update/current");
        if (cancelled) return;
        // 401 = a sessão expirou: o modal não abre (o login vai tratar).
        if (!res.ok || isAuthFailure(res)) return;

        const data = (await res.json()) as {
          jobId?: string | null;
          jobStatus?: string | null;
          job?: { id: string; status: string } | null;
          done?: boolean;
          finishedAt?: string | null;
        };
        if (cancelled) return;

        const status = data.jobStatus ?? data.job?.status ?? null;
        const id = data.jobId ?? data.job?.id ?? null;
        if (!id) return;

        if (isActiveStatus(status)) {
          // Update em andamento: reabre o modal e acompanha.
          show(id);
          return;
        }

        // Update terminado: mostra o estado final só se for recente (o
        // operador voltou logo depois). Um update de dias atrás não abre
        // modal nenhum.
        if (isTerminalStatus(status) && isRecent(data.finishedAt)) {
          show(id);
        }
      } catch {
        // API fora do ar: sem modal (não há nada a mostrar).
      }
    }

    check();

    return () => {
      cancelled = true;
    };
  }, [show]);

  // UM SÓ modal: quem abre é o watcher (o dono), o banner só pede para
  // abrir. Assim nunca existem dois overlays sobrepostos.
  if (!open) return null;
  return <UpdateProgressModal jobId={jobId} onClose={hide} />;
}

/** Um update terminado há pouco tempo ainda é relevante para o operador. */
function isRecent(finishedAt: string | null | undefined, windowMs = 10 * 60 * 1000): boolean {
  if (!finishedAt) return false;
  const at = Date.parse(finishedAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= windowMs;
}
