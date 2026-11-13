import type { Project } from "@korrelo/shared-types";

export type ApiFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type ReconcileResult =
  | { ok: true; project: Project }
  | { ok: false; status: number; message: string | null };

/**
 * Chama SOMENTE `POST /projects/:id/reconcile`.
 *
 * Não dispara deploy, rollback, restart nem qualquer outro endpoint — o
 * backend é quem valida container/imagem/readiness antes de liberar.
 */
export async function reconcileProjectState(
  fetcher: ApiFetcher,
  projectId: string,
): Promise<ReconcileResult> {
  const res = await fetcher(`/projects/${projectId}/reconcile`, { method: "POST" });
  if (res.ok) {
    return { ok: true, project: (await res.json()) as Project };
  }
  let message: string | null = null;
  try {
    const body = (await res.json()) as { message?: unknown; error?: { message?: unknown } };
    const raw = body?.message ?? body?.error?.message;
    if (typeof raw === "string" && raw.length > 0) message = raw;
  } catch {
    // Corpo não-JSON: mantém mensagem genérica na UI.
  }
  return { ok: false, status: res.status, message };
}
