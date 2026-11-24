"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../../lib/api-client";
import { useTranslation } from "../../../../lib/i18n/locale-provider";
import {
  describeDeployJob,
  formatDeployDateTime,
  formatDeployTime,
  type DeployJobPhase,
  type DeployJobView,
} from "./deploy-job-status";

/**
 * Painel da FILA de deploy do projeto.
 *
 * - consulta `GET /deploy-jobs?projectId=…` (mesma fila do worker);
 * - atualiza a cada 4 s SÓ enquanto existe job ativo; quando tudo termina,
 *   espaça para 30 s (sem polling agressivo na VPS);
 * - mostra "Solicitação recebida" separado de "Build iniciado"/"Concluído";
 * - exibe a falha de preflight (memória) mesmo sem DeployRecord;
 * - permite cancelar um job na fila e retomar um pausado no startup.
 */

const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 30_000;
const MAX_ROWS = 3;

export function DeployJobsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<DeployJobView[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const jobsRef = useRef<DeployJobView[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/deploy-jobs?limit=20&projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as DeployJobView[];
      if (aliveRef.current) setJobs(Array.isArray(data) ? data : []);
    } catch {
      // Falha de rede não apaga o último estado conhecido.
    }
  }, [projectId]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    aliveRef.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      await load();
      if (stopped || !aliveRef.current) return;
      const active = (jobsRef.current ?? []).some((job) => describeDeployJob(job).active);
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      timer = setTimeout(tick, hidden || !active ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function runAction(jobId: string, action: "cancel" | "resume") {
    setBusy(jobId);
    setActionError(null);
    try {
      const res = await apiFetch(`/deploy-jobs/${jobId}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          typeof body === "object" && body && "erro" in body ? String((body as { erro: unknown }).erro) : null;
        setActionError(message ?? t.projectDetail.deployJobActionFailed);
      }
      await load();
    } catch {
      setActionError(t.projectDetail.deployJobActionFailed);
    } finally {
      setBusy(null);
    }
  }

  if (!jobs || jobs.length === 0) return null;

  const rows = jobs.slice(0, MAX_ROWS);

  const phaseLabels: Record<DeployJobPhase, string> = {
    received: t.projectDetail.deployJobPhaseReceived,
    "waiting-resources": t.projectDetail.deployJobPhaseWaiting,
    paused: t.projectDetail.deployJobPhasePaused,
    starting: t.projectDetail.deployJobPhaseStarting,
    fetching: t.projectDetail.deployJobPhaseFetching,
    building: t.projectDetail.deployJobPhaseBuilding,
    staging: t.projectDetail.deployJobPhaseStaging,
    promoting: t.projectDetail.deployJobPhasePromoting,
    succeeded: t.projectDetail.deployJobPhaseSucceeded,
    failed: t.projectDetail.deployJobPhaseFailed,
    canceled: t.projectDetail.deployJobPhaseCanceled,
    interrupted: t.projectDetail.deployJobPhaseInterrupted,
  };

  return (
    <section className="mb-6 rounded-xl border border-border-subtle bg-surface">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h2 className="text-[13px] font-medium text-muted-foreground">{t.projectDetail.deployJobsTitle}</h2>
      </header>
      <ul className="divide-y divide-border-subtle">
        {rows.map((job) => {
          const description = describeDeployJob(job);
          const waiting = description.phase === "waiting-resources";
          const trigger =
            job.trigger === "webhook"
              ? t.projectDetail.deployJobTriggerWebhook
              : job.trigger === "staging"
                ? t.projectDetail.deployJobTriggerStaging
                : t.projectDetail.deployJobTriggerManual;
          return (
            <li key={job.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`text-[13px] font-medium ${
                    description.phase === "failed" || description.phase === "interrupted"
                      ? "text-destructive"
                      : description.phase === "waiting-resources" || description.phase === "paused"
                        ? "text-warning"
                        : description.phase === "succeeded"
                          ? "text-accent"
                          : "text-foreground"
                  }`}
                >
                  {phaseLabels[description.phase]}
                </span>
                <span className="text-[11.5px] text-muted-foreground">
                  {trigger} ·{" "}
                  {formatDeployDateTime(job.createdAt)}
                </span>
                {job.commitSha && (
                  <code className="font-mono text-[11.5px] text-muted-foreground">{job.commitSha.slice(0, 8)}</code>
                )}
                {waiting && (
                  <span className="text-[11.5px] text-muted-foreground">
                    {t.projectDetail.deployJobAttempt
                      .replace("{attempt}", String(job.attempt))
                      .replace("{max}", String(description.maxAttempts ?? "?"))}
                  </span>
                )}
                {waiting && job.runtime?.nextAttemptAt && (
                  <span className="text-[11.5px] text-muted-foreground">
                    {t.projectDetail.deployJobNextCheck.replace(
                      "{time}",
                      formatDeployTime(job.runtime.nextAttemptAt ?? ""),
                    )}
                  </span>
                )}
                {description.canCancel && (
                  <button
                    type="button"
                    onClick={() => void runAction(job.id, "cancel")}
                    disabled={busy === job.id}
                    className="text-[11.5px] font-medium text-destructive hover:opacity-80 disabled:opacity-50"
                  >
                    {t.projectDetail.deployJobCancel}
                  </button>
                )}
                {description.canResume && (
                  <button
                    type="button"
                    onClick={() => void runAction(job.id, "resume")}
                    disabled={busy === job.id}
                    className="text-[11.5px] font-medium text-accent hover:opacity-80 disabled:opacity-50"
                  >
                    {t.projectDetail.deployJobResume}
                  </button>
                )}
              </div>
              {job.errorMessage && (
                <p className="mt-1 text-[12px] text-muted-foreground" title={job.errorMessage}>
                  {job.errorMessage}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {actionError && <p className="border-t border-border-subtle px-4 py-2 text-[12px] text-destructive">{actionError}</p>}
    </section>
  );
}
