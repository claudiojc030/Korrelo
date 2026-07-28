export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    // Token de auth vive num cookie httpOnly agora — o navegador manda
    // sozinho, não tem mais Authorization montado a partir de JS.
    credentials: "include",
  });
}
