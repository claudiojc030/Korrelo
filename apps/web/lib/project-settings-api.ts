export type ApiFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type PatchSettingsResult =
  | { ok: true }
  | { ok: false; status: number; message: string | null };

/** PATCH /projects/:id/settings com mensagem de erro real quando houver. */
export async function patchProjectSettings(
  fetcher: ApiFetcher,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<PatchSettingsResult> {
  const res = await fetcher(`/projects/${projectId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.ok) return { ok: true };

  let message: string | null = null;
  try {
    const body = (await res.json()) as { message?: unknown; error?: { message?: unknown } };
    const raw = body?.message ?? body?.error?.message;
    if (typeof raw === "string" && raw.length > 0) message = raw;
  } catch {
    // Sem corpo JSON: a UI usa a mensagem genérica.
  }
  return { ok: false, status: res.status, message };
}
