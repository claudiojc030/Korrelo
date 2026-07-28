import { cookies } from "next/headers";
import { TOKEN_COOKIE } from "./auth-cookie-client";

export function getTokenServer(): string | null {
  return cookies().get(TOKEN_COOKIE)?.value ?? null;
}

export function authHeaderServer(): Record<string, string> {
  const token = getTokenServer();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
