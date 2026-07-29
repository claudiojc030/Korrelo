"use client";

import { Languages } from "lucide-react";
import { useTranslation } from "../lib/i18n/locale-provider";

export function LanguageToggle() {
  const { locale, setLocale, t } = useTranslation();

  return (
    <button
      onClick={() => setLocale(locale === "pt" ? "en" : "pt")}
      className="flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <Languages size={18} strokeWidth={1.75} className="flex-none" />
      {t.nav.languageSwitchTo}
    </button>
  );
}
