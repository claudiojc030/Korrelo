"use client";

import { useEffect, useState, use } from "react";
import { Plus, Trash2, Save, Loader2, Eye, EyeOff, KeyRound, ClipboardPaste } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";
import { parseEnvText } from "../../../../../lib/parse-env-text";
import { PasteEnvModal } from "../../../../../components/paste-env-modal";

interface EnvRow {
  key: string;
  value: string;
}

export default function EnvVarsPage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);
  const { t } = useTranslation();
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revealAll, setRevealAll] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

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

  async function handlePasteImport(text: string) {
    const parsed = parseEnvText(text);
    const keys = Object.keys(parsed);
    if (keys.length === 0) {
      throw new Error(t.projectEnv.pasteEnvEmptyError);
    }

    setRows((prev) => {
      const next = prev.filter((row) => row.key.trim().length > 0).map((row) => ({ ...row }));
      for (const key of keys) {
        const existing = next.find((row) => row.key === key);
        if (existing) {
          existing.value = parsed[key];
        } else {
          next.push({ key, value: parsed[key] });
        }
      }
      return next;
    });
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
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projectEnv.saveError));
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectEnv.unknownError);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-[13px] text-muted-foreground">{t.common.loading}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
            <KeyRound size={15} strokeWidth={1.75} />
            {t.projectEnv.title}
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.projectEnv.subtitle}</p>
        </div>
        <div className="flex flex-none items-center gap-3">
          <button
            onClick={() => setPasteOpen(true)}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:opacity-85"
          >
            <ClipboardPaste size={14} strokeWidth={1.75} />
            {t.projectEnv.pasteEnvButton}
          </button>
          <button
            onClick={() => setRevealAll((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            {revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
            {revealAll ? t.projectEnv.hideValues : t.projectEnv.showValues}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={row.key}
                onChange={(e) => updateRow(index, "key", e.target.value.toUpperCase())}
                placeholder={t.projectEnv.keyPlaceholder}
                spellCheck={false}
                className="w-64 flex-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
              />
              <input
                type={revealAll ? "text" : "password"}
                value={row.value}
                onChange={(e) => updateRow(index, "value", e.target.value)}
                placeholder={t.projectEnv.valuePlaceholder}
                spellCheck={false}
                className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
              />
              <button
                onClick={() => removeRow(index)}
                aria-label={t.projectEnv.removeVarAriaLabel}
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
          {t.projectEnv.addVarButton}
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
          {t.common.save}
        </button>
        {saved && <span className="text-[12.5px] text-accent">{t.projectEnv.saved}</span>}
      </div>

      {pasteOpen && (
        <PasteEnvModal
          title={t.projectEnv.pasteEnvTitle}
          description={t.projectEnv.pasteEnvDescription}
          placeholder={t.projectEnv.pasteEnvPlaceholder}
          importLabel={t.projectEnv.pasteEnvImportButton}
          cancelLabel={t.common.cancel}
          onImport={handlePasteImport}
          onClose={() => setPasteOpen(false)}
        />
      )}
    </div>
  );
}
