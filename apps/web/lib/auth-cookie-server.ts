import { cookies } from "next/headers";
import { TOKEN_COOKIE } from "./auth-cookie-client";

export async function getTokenServer(): Promise<string | null> {
  const store = await cookies();
  return store.get(TOKEN_COOKIE)?.value ?? null;
}

export async function authHeaderServer(): Promise<Record<string, string>> {
  const token = await getTokenServer();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
