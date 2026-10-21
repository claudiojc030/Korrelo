"use client";

import { HardDrive } from "lucide-react";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { StoragePanel } from "./storage-panel";

/**
 * PÁGINA DE ARMAZENAMENTO.
 *
 * Item de primeiro nível na sidebar (entre "Terminal da VPS" e "Segurança").
 * A auditoria/limpeza de armazenamento mora aqui - o Dashboard continua
 * curto, com só os cards de CPU/Memória/Disco/Uptime.
 */
export default function StoragePage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <HardDrive size={16} strokeWidth={1.75} className="text-foreground" />
        <h1 className="text-[15px] font-semibold text-foreground">{t.storage.pageTitle}</h1>
      </div>
      <p className="mb-5 text-[12.5px] text-muted-foreground">{t.storage.pageDescription}</p>

      <StoragePanel />
    </div>
  );
}
