"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Atualização periódica do conteúdo da página.
 *
 * Três proteções (todas ligadas pelo incidente de 19/10/2026):
 * - Intervalo maior (30s em vez de 12s): o dashboard fazia 5 chamadas de
 *   servidor por refresh, incluindo a coleta de métricas (que fala com o
 *   Docker). 12s era rápido demais pra uma VPS de 1 vCPU.
 * - Aba escondida não atualiza: ninguém está olhando e o consumo é real.
 * - Não sobrepõe refreshes: com a API lenta, cada tick criava uma nova
 *   requisição que ficava pendurada, acumulando carga no servidor.
 */
export function AutoRefresh({ intervalMs = 30000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const refresh = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (isPending) return;
      startTransition(() => {
        router.refresh();
      });
    };

    const interval = setInterval(refresh, intervalMs);

    // Ao voltar pra aba, atualiza na hora (em vez de esperar o próximo tick).
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, intervalMs, isPending]);

  return null;
}
