"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Save, Loader2, Eye, EyeOff, KeyRound } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";

interface EnvRow {
  key: string;
  value: string;
}

export default function EnvVarsPage({ params }: { params: { projectId: string } }) {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revealAll, setRevealAll] = useState(false);

  useEffect(() => {
    apiFetch(`/projects/${params.projectId}/env`)
      .then((res) => res.json())
      .then((data: EnvRow[]) => setRows(data.length > 0 ? data : [{ key: "", value: "" }]))
      .catch(() => setRows([{ key: "", value: "" }]))
      .finally(() => setLoading(false));
  }, [params.projectId]);

  function updateRow(index: number, field: keyof EnvRow, value: string) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setSaved(false);
  }

  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "" }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const vars = rows.filter((r) => r.key.trim().length > 0);
      const res = await apiFetch(`/projects/${params.projectId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Falha ao salvar.");
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
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
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
            <KeyRound size={15} strokeWidth={1.75} />
            Variáveis de ambiente
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Aplicadas no próximo deploy, precisa dar Deploy de novo pra valer pro container já rodando.
          </p>
        </div>
        <button
          onClick={() => setRevealAll((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          {revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
          {revealAll ? "Ocultar valores" : "Mostrar valores"}
        </button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={row.key}
                onChange={(e) => updateRow(index, "key", e.target.value.toUpperCase())}
                placeholder="NOME_DA_VARIAVEL"
                spellCheck={false}
                className="w-64 flex-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
              />
              <input
                type={revealAll ? "text" : "password"}
                value={row.value}
                onChange={(e) => updateRow(index, "value", e.target.value)}
                placeholder="valor"
                spellCheck={false}
                className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
              />
              <button
                onClick={() => removeRow(index)}
                aria-label="Remover variável"
                className="flex-none rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={addRow}
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <Plus size={14} strokeWidth={1.75} />
          Adicionar variável
        </button>
      </div>

      {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} strokeWidth={1.75} />}
          Salvar
        </button>
        {saved && <span className="text-[12.5px] text-accent">Salvo.</span>}
      </div>
    </div>
  );
}
