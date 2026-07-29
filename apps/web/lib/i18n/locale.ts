export const LOCALE_STORAGE_KEY = "korrelo-locale";
export const LOCALE_COOKIE_KEY = "korrelo_locale";

export type Locale = "pt" | "en";

export function getStoredLocale(): Locale {
  if (typeof document === "undefined") return "pt";
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE_KEY}=([^;]*)`));
  return match?.[1] === "en" ? "en" : "pt";
}

export function applyLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE_KEY}=${locale}; path=/; max-age=31536000; samesite=lax`;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage indisponível (modo privado, etc), idioma ainda funciona,
    // só não persiste entre sessões sem o cookie.
  }
}
