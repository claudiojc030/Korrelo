export const THEME_STORAGE_KEY = "forgedesk-theme";

export type Theme = "light" | "dark";

export function getStoredTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const current = document.documentElement.getAttribute("data-theme");
  return current === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage indisponível (modo privado, etc), tema ainda funciona,
    // só não persiste entre sessões.
  }
}
