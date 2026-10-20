export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Socket.IO usa o path fixo /socket.io/ + o namespace vem da URL passada pro
// cliente (io(`${SOCKET_URL}/terminal}`)) - se API_URL termina em "/api" (caso
// sem domínio próprio, proxied pelo Nginx), grudar o namespace direto nele
// vira "/api/terminal", que o servidor não reconhece ("Invalid namespace").
// O Nginx já roteia /socket.io/ pro backend certo independente do path aqui,
// então só a origem (sem o sufixo /api) importa pro namespace bater.
export const SOCKET_URL = API_URL.replace(/\/api\/?$/, "");

const AUTH_PATHS_WITHOUT_RETRY = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];

/**
 * Tempo limite padrão das chamadas feitas pelo navegador. Sem isso, uma API
 * lenta deixava o spinner na tela pra sempre (e o polling continuava
 * empilhando requisições). 20s cobre a consulta de banco mais pesada que
 * existe hoje (o próprio backend corta em 15s).
 */
const DEFAULT_CLIENT_TIMEOUT_MS = 20_000;

let inFlightRefresh: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

export interface ApiFetchOptions extends RequestInit {
  /** Tempo limite da requisição. Padrão: 20s. */
  timeoutMs?: number;
}

/**
 * Wave 3: a API do Korrelo reinicia durante o self-update. Um erro de
 * rede (API fora do ar) ou um 5xx NÃO é "sessão inválida" - tratá-lo como
 * logout expulsava o usuário da própria sessão durante a atualização.
 *
 * Só uma resposta 401 real (token/refresh inválido, sessão revogada) pode
 * invalidar a sessão.
 */
export function isAuthFailure(response: Response): boolean {
  return response.status === 401;
}

/** 502/503/504: o gateway/backend não respondeu agora - é transitório. */
export function isTransientServerError(response: Response): boolean {
  return [502, 503, 504].includes(response.status);
}

/** Erro de rede (API reiniciando, conexão recusada, timeout de socket). */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as Error).name;
  const message = String((error as Error).message ?? "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|network error|xhr poll error/i.test(message);
}

/**
 * Backoff do polling durante a indisponibilidade transitória:
 * 1s, 2s, 3s, 5s, 5s, 5s... (limitado).
 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 3000, 5000, 5000];

export function backoffDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[index];
}

export async function apiFetch(path: string, init: ApiFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS, ...requestInit } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...requestInit,
      // Token de auth vive num cookie httpOnly agora, o navegador manda
      // sozinho, não tem mais Authorization montado a partir de JS.
      credentials: "include",
      signal: controller.signal,
    });

    if (response.status !== 401 || AUTH_PATHS_WITHOUT_RETRY.includes(path)) {
      return response;
    }

    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      return response;
    }

    return fetch(`${API_URL}${path}`, {
      ...requestInit,
      credentials: "include",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
