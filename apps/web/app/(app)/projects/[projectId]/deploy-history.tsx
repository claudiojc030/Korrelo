"use client";

import { useEffect, useState } from "react";
import { Webhook, MousePointerClick } from "lucide-react";
import { apiFetch } from "../../../../lib/api-client";
import { useTranslation } from "../../../../lib/i18n/locale-provider";

interface DeployRecord {
  id: string;
  status: "running" | "success" | "failed";
  triggeredBy: "manual" | "webhook";
  errorMessage: string | null;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

const POLL_MS = 2000;

export function DeployHistory({ projectId, initialRecords }: { projectId: string; initialRecords: DeployRecord[] }) {
  const { t } = useTranslation();
  const [records, setRecords] = useState(initialRecords);

  useEffect(() => {
    if (!records.some((r) => r.status === "running")) return;
    // Só faz polling enquanto algum deploy estiver rodando, pra dar
    // visibilidade de andamento igual o histórico do Render.
    const interval = setInterval(async () => {
      const res = await apiFetch(`/projects/${projectId}/deploys`);
      if (res.ok) setRecords(await res.json());
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [projectId, records]);

  if (records.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t.projectDetail.noDeploysYet}</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      {records.map((record) => {
        const statusStyle =
          record.status === "success" ? "text-accent" : record.status === "failed" ? "text-destructive" : "text-warning";
        const statusLabel =
          record.status === "success"
            ? t.projectDetail.deployStatusSuccess
            : record.status === "failed"
              ? t.projectDetail.deployStatusFailed
              : t.projectDetail.deployStatusInProgress;
        const durationMs = record.finishedAt
          ? new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()
          : null;

        return (
          <details key={record.id} className="group border-b border-border-subtle last:border-0">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <div className="flex items-center gap-2.5">
                {record.triggeredBy === "webhook" ? (
                  <Webhook size={13} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                ) : (
                  <MousePointerClick size={13} strokeWidth={1.75} className="flex-none text-muted-foreground" />
                )}
                <div>
                  <p className="text-[13px] text-foreground">
                    {new Date(record.startedAt).toLocaleString("pt-BR")}
                    <span className="ml-2 text-[11.5px] text-muted-foreground">
                      {record.triggeredBy === "webhook" ? t.projectDetail.triggeredByWebhook : t.projectDetail.triggeredByManual}
                    </span>
                  </p>
                  {record.errorMessage && (
                    <p className="mt-0.5 max-w-md truncate text-[12px] text-destructive">{record.errorMessage}</p>
                  )}
                </div>
              </div>
              <div className="flex flex-none items-center gap-3 text-[12.5px]">
                {durationMs != null && <span className="text-muted-foreground">{Math.round(durationMs / 1000)}s</span>}
                <span className={`font-medium ${statusStyle}`}>{statusLabel}</span>
              </div>
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle bg-background px-4 py-3 font-mono text-[12px] text-muted-foreground">
              {record.log || t.projectDetail.noDeployLogYet}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
