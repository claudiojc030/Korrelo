"use client";

import { useEffect, useState } from "react";
import { Clock, Loader2, Play, Trash2, TriangleAlert } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";

interface CronJob {
  id: string;
  projectId: string;
  name: string;
  command: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastOutput: string | null;
  createdAt: string;
}

const SCHEDULE_EXAMPLES = [
  { expr: "*/5 * * * *", label: "a cada 5 minutos" },
  { expr: "0 * * * *", label: "a cada hora" },
  { expr: "0 3 * * *", label: "todo dia às 3h" },
  { expr: "0 0 * * 0", label: "toda semana, domingo à meia-noite" },
];

function StatusBadge({ status }: { status: CronJob["lastStatus"] }) {
  if (!status) return <span className="text-[12px] text-muted-foreground">Nunca rodou</span>;
  if (status === "success") {
    return <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Sucesso</span>;
  }
  return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">Falhou</span>;
}

export default function CronPage({ params }: { params: { projectId: string } }) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [schedule, setSchedule] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    apiFetch(`/projects/${params.projectId}/cron`)
      .then((res) => (res.ok ? res.json() : []))
      .then(setJobs)
      .catch(() => setJobs([]));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.projectId]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await apiFetch(`/projects/${params.projectId}/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command, schedule }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao criar o cron job.");
      }
      setName("");
      setCommand("");
      setSchedule("");
      setFormOpen(false);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleEnabled(job: CronJob) {
    setPendingId(job.id);
    try {
      await apiFetch(`/projects/${params.projectId}/cron/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      load();
    } finally {
      setPendingId(null);
    }
  }

  async function handleRunNow(jobId: string) {
    setPendingId(jobId);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${params.projectId}/cron/${jobId}/run`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao rodar o cron job.");
      }
      setExpandedId(jobId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(jobId: string) {
    setPendingId(jobId);
    try {
      await apiFetch(`/projects/${params.projectId}/cron/${jobId}`, { method: "DELETE" });
      setConfirmDeleteId(null);
      load();
    } finally {
      setPendingId(null);
    }
  }

  if (jobs === null) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <Clock size={16} strokeWidth={1.75} />
            Tarefas agendadas (cron)
          </h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Cada tarefa roda o comando dentro do container deste projeto, no horário definido.
          </p>
        </div>
        <button
          onClick={() => setFormOpen((v) => !v)}
          className="rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          {formOpen ? "Cancelar" : "Nova tarefa"}
        </button>
      </div>

      {error && <p className="mb-3 text-[13px] text-destructive">{error}</p>}

      {formOpen && (
        <form
          onSubmit={handleCreate}
          className="mb-5 flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4"
        >
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">Nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Limpar cache antigo"
              required
              className="w-full rounded-md border border-border-subtle bg-transparent px-3 py-2 text-[13px] text-foreground outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">Comando (roda dentro do container)</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm run cron:limpar-cache"
              required
              className="w-full rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">Agendamento (expressão cron)</label>
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 3 * * *"
              required
              className="w-full rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SCHEDULE_EXAMPLES.map((ex) => (
                <button
                  type="button"
                  key={ex.expr}
                  onClick={() => setSchedule(ex.expr)}
                  className="rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-muted-foreground hover:border-accent hover:text-foreground"
                >
                  <span className="font-mono">{ex.expr}</span> · {ex.label}
                </button>
              ))}
            </div>
          </div>
          {formError && <p className="text-[12.5px] text-destructive">{formError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Criar tarefa
          </button>
        </form>
      )}

      {jobs.length === 0 && !formOpen && (
        <p className="text-[13px] text-muted-foreground">Nenhuma tarefa agendada pra este projeto ainda.</p>
      )}

      <div className="flex flex-col gap-3">
        {jobs.map((job) => (
          <div key={job.id} className="rounded-xl border border-border-subtle bg-surface p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13.5px] font-medium text-foreground">{job.name}</p>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {job.schedule}
                  </span>
                  <StatusBadge status={job.lastStatus} />
                </div>
                <p className="mt-1 truncate font-mono text-[12.5px] text-muted-foreground">{job.command}</p>
                <p className="mt-1 text-[11.5px] text-muted-foreground/80">
                  {job.lastRunAt ? `Última execução: ${new Date(job.lastRunAt).toLocaleString("pt-BR")}` : "Nunca rodou ainda"}
                </p>
              </div>

              <div className="flex flex-none items-center gap-2">
                <button
                  onClick={() => handleRunNow(job.id)}
                  disabled={pendingId === job.id}
                  title="Rodar agora"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {pendingId === job.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Rodar agora
                </button>
                <button
                  role="switch"
                  aria-checked={job.enabled}
                  disabled={pendingId === job.id}
                  onClick={() => handleToggleEnabled(job)}
                  className={`relative h-6 w-11 flex-none rounded-full transition-colors disabled:opacity-40 ${
                    job.enabled ? "bg-accent" : "bg-muted"
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      job.enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(job.id)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remover"
                >
                  <Trash2 size={15} strokeWidth={1.75} />
                </button>
              </div>
            </div>

            {job.lastOutput && (
              <button
                onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
              >
                {expandedId === job.id ? "Ocultar saída" : "Ver saída da última execução"}
              </button>
            )}
            {expandedId === job.id && job.lastOutput && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-3 font-mono text-[11.5px] text-foreground">
                {job.lastOutput}
              </pre>
            )}

            {confirmDeleteId === job.id && (
              <div
                role="dialog"
                aria-modal="true"
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
                onClick={() => setConfirmDeleteId(null)}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
                      <TriangleAlert size={16} strokeWidth={1.75} />
                    </div>
                    <div>
                      <p className="text-[14.5px] font-semibold text-foreground">Remover "{job.name}"?</p>
                      <p className="mt-1 text-[13px] text-muted-foreground">Não pode ser desfeito.</p>
                    </div>
                  </div>
                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => handleDelete(job.id)}
                      disabled={pendingId === job.id}
                      className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {pendingId === job.id && <Loader2 size={14} className="animate-spin" />}
                      Remover
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
