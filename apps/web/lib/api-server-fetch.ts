import { API_URL } from "./api-client";

/**
 * Fetch usado pelos Server Components (páginas renderizadas no servidor).
 *
 * Motivo: no incidente de 19/10/2026 o `fetch` global (sem timeout) ficava
 * pendurado quando a API demorava, e a página inteira ficava esperando. O
 * Nginx só desistia 60 s depois (504). Com timeout aqui, a página renderiza
 * rápido mostrando o estado "indisponível" em vez de travar.
 *
 * O limite é configurável por variável de ambiente porque depende do
 * ambiente (uma VPS sob carga legítima pode precisar de mais tempo).
 */
export const DEFAULT_SSR_FETCH_TIMEOUT_MS = 8_000;

export type ApiServerFailureReason = "timeout" | "network" | "http";

export type ApiServerResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ApiServerFailureReason; status: number | null; message: string };

export interface ApiServerFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchApiServer<T>(
  path: string,
  options: ApiServerFetchOptions = {},
): Promise<ApiServerResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSR_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    // `cache` faz parte do RequestInit do DOM/Next (e é o que garante dado
    // fresco no server). O cast mantém o mesmo código funcionando também
    // fora do app web (onde o tipo do Node não declara essa propriedade).
    const init = {
      cache: "no-store",
      headers: options.headers,
      signal: controller.signal,
    } as RequestInit;

    const response = await fetch(`${API_URL}${path}`, init);

    if (!response.ok) {
      return {
        ok: false,
        reason: "http",
        status: response.status,
        message: `A API respondeu ${response.status}.`,
      };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        reason: "timeout",
        status: null,
        message: `A API não respondeu em ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    return {
      ok: false,
      reason: "network",
      status: null,
      message: error instanceof Error ? error.message : "Falha de rede ao falar com a API.",
    };
  } finally {
    clearTimeout(timer);
  }
}
