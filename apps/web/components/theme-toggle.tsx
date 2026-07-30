"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, getStoredTheme, type Theme } from "../lib/theme";
import { useTranslation } from "../lib/i18n/locale-provider";

export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // localStorage só existe no cliente, depois do hydrate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(getStoredTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  }

  // Evita mismatch de hidratação: só decide o ícone depois de ler o DOM no client.
  if (theme === null) {
    return <div className="h-[38px] w-full" />;
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      {theme === "light" ? (
        <Moon size={18} strokeWidth={1.75} className="flex-none" />
      ) : (
        <Sun size={18} strokeWidth={1.75} className="flex-none" />
      )}
      {theme === "light" ? t.nav.darkTheme : t.nav.lightTheme}
    </button>
  );
}
