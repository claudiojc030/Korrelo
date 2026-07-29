"use client";

import { useState } from "react";
import { ArrowUpCircle, Check, Copy } from "lucide-react";
import { useTranslation } from "../../../lib/i18n/locale-provider";

interface UpdateStatus {
  checked: boolean;
  currentCommit: string | null;
  remoteCommit: string | null;
  commitsBehind: number;
  updateAvailable: boolean;
}

const UPDATE_COMMAND = `cd korrelo && git pull && npm install && \\
npm run build --workspace=packages/shared-types && \\
npm run build --workspace=apps/api && \\
npm run build --workspace=apps/web && \\
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && \\
(cd apps/api && npx prisma migrate deploy) && \\
pm2 restart ecosystem.config.js`;

export function UpdateBanner({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!status.updateAvailable) {
    return null;
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API pode falhar (permissão negada, contexto não-seguro,
      // documento sem foco). Sem feedback de "copiado", mas o comando
      // continua selecionável manualmente no <pre> acima.
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-accent/30 bg-accent/10 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <ArrowUpCircle size={17} strokeWidth={1.75} className="flex-none text-accent" />
          <p className="text-[13.5px] font-medium text-foreground">
            {t.dashboard.updateAvailable}
            <span className="ml-1.5 font-normal text-muted-foreground">
              ({status.commitsBehind} {status.commitsBehind === 1 ? t.dashboard.commitsBehindSingular : t.dashboard.commitsBehindPlural})
            </span>
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-none text-[12.5px] font-medium text-accent hover:opacity-85"
        >
          {expanded ? t.dashboard.hideCommand : t.dashboard.showCommand}
        </button>
      </div>

      {expanded && (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] text-muted-foreground">{t.dashboard.runViaSsh}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground">
              {UPDATE_COMMAND}
            </pre>
            <button
              onClick={handleCopy}
              aria-label={t.dashboard.copyCommand}
              className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t.dashboard.copied : t.common.copy}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
