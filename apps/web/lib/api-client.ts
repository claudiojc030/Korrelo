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

/**
 * Resultado da tentativa de renovar a sessão.
 *
 * - "refreshed": deu certo, a requisição original pode ser repetida;
 * - "expired": a sessão MORREU de verdade (401/403 no refresh: token
 *   expirado, revogado ou inexistente) - aí sim é logout;
 * - "unavailable": a API não respondeu ou respondeu 5xx - a sessão pode
 *   estar perfeitamente válida e o operador NÃO pode ser deslogado por
 *   isso (é o que acontecia: um 503 durante um restart do PM2 expulsava o
 *   usuário da própria sessão).
 */
export type RefreshOutcome = "refreshed" | "expired" | "unavailable";

let inFlightRefresh: Promise<RefreshOutcome> | null = null;

/**
 * SINGLE-FLIGHT: várias requisições que receberam 401 ao mesmo tempo
 * compartilham UM único refresh (e todas repetem a requisição depois).
 */
function refreshAccessToken(): Promise<RefreshOutcome> {
  if (!inFlightRefresh) {
    inFlightRefresh = fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (res.ok) return "refreshed" as const;
        // 401/403 = sessão expirada/revogada de verdade.
        if (res.status === 401 || res.status === 403) return "expired" as const;
        // 5xx = API indisponível agora (carga, restart do PM2 no
        // self-update): a sessão pode estar válida - NÃO desloga.
        return "unavailable" as const;
      })
      .catch((error) => {
        // Erro de rede/timeout: a API está fora do ar. Mesma lógica de
        // "unavailable" - deslogar por indisponibilidade é o bug antigo.
        if (isNetworkError(error)) return "unavailable" as const;
        return "unavailable" as const;
      })
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

/**
 * A sessão não pôde ser renewada porque a API estava indisponível (5xx ou
 * erro de rede) - e NÃO porque a sessão morreu.
 *
 * A UI mostra "Reconectando ao Korrelo..." em vez de expulsar o usuário.
 */
export function isSessionUnavailable(response: Response): boolean {
  return response.headers.get("x-korrelo-session") === "unavailable";
}

/**
 * Resposta sintética para "a API está indisponível".
 *
 * O status 503 (e não o 401 original) é o que impede o logout: todo o
 * código que trata 401 como "sessão morta" continua funcionando igual, e
 * quem olha isTransientServerError() já sabe o que fazer.
 */
function sessionUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "API_UNAVAILABLE",
      message: "O Korrelo não está respondendo agora. A sessão foi mantida.",
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-korrelo-session": "unavailable",
      },
    },
  );
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

    const outcome = await refreshAccessToken();

    if (outcome === "refreshed") {
      // Sessão renovada: repete a requisição original.
      return fetch(`${API_URL}${path}`, {
        ...requestInit,
        credentials: "include",
        signal: controller.signal,
      });
    }

    if (outcome === "unavailable") {
      // A API está fora do ar (5xx/rede): a sessão pode estar válida.
      // Devolve 503 (e não 401) pra NINGUÉM deslogar o operador.
      return sessionUnavailableResponse();
    }

    // "expired": a sessão morreu de verdade (401/403 no refresh).
    return response;
  } finally {
    clearTimeout(timer);
  }
}
