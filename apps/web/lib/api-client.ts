import { getTokenClient } from "./auth-cookie-client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getTokenClient();
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
