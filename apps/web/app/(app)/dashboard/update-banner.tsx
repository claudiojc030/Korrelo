"use client";

import { useState } from "react";
import { ArrowUpCircle, Check, Copy } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { UpdateProgressModal } from "./update-progress-modal";

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
  const [updating, setUpdating] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

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

  async function handleUpdateNow() {
    setStartError(null);
    try {
      const res = await apiFetch("/monitoring/update/start", { method: "POST" });
      if (!res.ok) {
        setStartError(t.dashboard.updateStartFailed);
        return;
      }
      const data: { alreadyRunning: boolean } = await res.json();
      if (data.alreadyRunning) {
        setStartError(t.dashboard.updateAlreadyRunning);
      }
      // Mesmo se já estava rodando, abre o modal pra acompanhar o progresso
      // em vez de deixar o usuário sem feedback nenhum.
      setUpdating(true);
    } catch {
      setStartError(t.dashboard.updateStartFailed);
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
        <div className="flex flex-none items-center gap-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[12.5px] font-medium text-accent hover:opacity-85"
          >
            {expanded ? t.dashboard.hideCommand : t.dashboard.showCommand}
          </button>
          <button
            onClick={handleUpdateNow}
            className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground hover:opacity-90"
          >
            {t.dashboard.updateNowButton}
          </button>
        </div>
      </div>

      {startError && <p className="mt-2 text-[12.5px] text-destructive">{startError}</p>}

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

      {updating && <UpdateProgressModal onClose={() => setUpdating(false)} />}
    </div>
  );
}
