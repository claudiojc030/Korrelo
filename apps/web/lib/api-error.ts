import type { Dictionary } from "./i18n/dictionaries";

export function translateApiError(t: Dictionary, body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string" && t.apiErrors[code]) {
      return t.apiErrors[code];
    }
  }
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
