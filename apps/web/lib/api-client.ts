export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Socket.IO usa o path fixo /socket.io/ + o namespace vem da URL passada pro
// cliente (io(`${SOCKET_URL}/terminal}`)) - se API_URL termina em "/api" (caso
// sem domínio próprio, proxied pelo Nginx), grudar o namespace direto nele
// vira "/api/terminal", que o servidor não reconhece ("Invalid namespace").
// O Nginx já roteia /socket.io/ pro backend certo independente do path aqui,
// então só a origem (sem o sufixo /api) importa pro namespace bater.
export const SOCKET_URL = API_URL.replace(/\/api\/?$/, "");

const AUTH_PATHS_WITHOUT_RETRY = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];

let inFlightRefresh: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    // Token de auth vive num cookie httpOnly agora, o navegador manda
    // sozinho, não tem mais Authorization montado a partir de JS.
    credentials: "include",
  });

  if (response.status !== 401 || AUTH_PATHS_WITHOUT_RETRY.includes(path)) {
    return response;
  }

  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    return response;
  }

  return fetch(`${API_URL}${path}`, { ...init, credentials: "include" });
}
