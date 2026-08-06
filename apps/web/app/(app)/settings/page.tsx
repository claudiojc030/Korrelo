"use client";

import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Globe, KeyRound, Plus, Trash2, Save, Loader2, Eye, EyeOff, TriangleAlert, ClipboardPaste } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../lib/api-error";
import { PasteEnvModal } from "../../../components/paste-env-modal";

interface EnvRow {
  key: string;
  value: string;
}

export default function SettingsPage() {
  const { t } = useTranslation();

  const [domain, setDomain] = useState<string | null | undefined>(undefined);
  const [domainInput, setDomainInput] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState(false);

  const [rows, setRows] = useState<EnvRow[]>([]);
  const [envLoading, setEnvLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revealAll, setRevealAll] = useState(false);

  const [pasteOpen, setPasteOpen] = useState(false);

  function loadEnv() {
    setEnvLoading(true);
    apiFetch("/settings/env")
      .then((res) => res.json())
      .then((data: EnvRow[]) => setRows(data.length > 0 ? data : [{ key: "", value: "" }]))
      .catch(() => setRows([{ key: "", value: "" }]))
      .finally(() => setEnvLoading(false));
  }

  function loadDomain() {
    apiFetch("/settings/domain")
      .then((res) => (res.ok ? res.json() : { domain: null }))
      .then((data: { domain: string | null }) => setDomain(data.domain))
      .catch(() => setDomain(null));
  }

  useEffect(() => {
    loadDomain();
    // loadEnv seta envLoading de forma síncrona antes do fetch assíncrono.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEnv();
  }, []);

  async function handlePasteImport(text: string) {
    const res = await apiFetch("/settings/env/bulk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(translateApiError(t, body, t.settings.pasteEnvError));
    }
    loadEnv();
  }

  async function handleAttach() {
    if (!domainInput.trim()) return;
    setAttaching(true);
    setDomainError(null);
    try {
      const res = await apiFetch("/settings/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domainInput }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.settings.attachError));
      }
      setDomainInput("");
      loadDomain();
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : t.settings.unknownError);
    } finally {
      setAttaching(false);
    }
  }

  async function handleDetach() {
    setDetaching(true);
    setDomainError(null);
    try {
      const res = await apiFetch("/settings/domain", { method: "DELETE" });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.settings.detachError));
      }
      setConfirmDetach(false);
      loadDomain();
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : t.settings.unknownError);
    } finally {
      setDetaching(false);
    }
  }

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

  async function handleSaveEnv() {
    setSaving(true);
    setEnvError(null);
    setSaved(false);
    try {
      const vars = rows.filter((r) => r.key.trim().length > 0);
      for (const v of vars) {
        const res = await apiFetch("/settings/env", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(v),
        });
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          throw new Error(translateApiError(t, body, t.settings.saveError));
        }
      }
      setSaved(true);
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : t.settings.unknownError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-6">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <SettingsIcon size={17} strokeWidth={1.75} />
          {t.settings.title}
        </p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.settings.subtitle}</p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-5">
        <div className="flex items-center gap-2 text-foreground">
          <Globe size={15} strokeWidth={1.75} />
          <span className="text-[13.5px] font-medium">{t.settings.domainSectionTitle}</span>
        </div>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{t.settings.domainSectionDescription}</p>

        {domain === undefined ? (
          <p className="mt-3 text-[13px] text-muted-foreground">{t.common.loading}</p>
        ) : domain ? (
          <div className="mt-3">
            <p className="font-mono text-[13px] text-foreground">
              {t.settings.domainAttachedPrefix}
              {domain}
            </p>
            <div className="mt-2.5 flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 flex-none" />
              <span>{t.settings.domainAttachedWarning}</span>
            </div>
            <button
              onClick={() => setConfirmDetach(true)}
              className="mt-3 text-[13px] font-medium text-destructive hover:opacity-85"
            >
              {t.settings.detachButton}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder={t.settings.domainPlaceholder}
              spellCheck={false}
              className="flex-1 rounded-md border border-border-subtle bg-transparent px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent"
            />
            <button
              onClick={handleAttach}
              disabled={attaching || !domainInput.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {attaching && <Loader2 size={14} className="animate-spin" />}
              {t.settings.attachButton}
            </button>
          </div>
        )}

        {domainError && <p className="mt-2 text-[13px] text-destructive">{domainError}</p>}
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
              <KeyRound size={15} strokeWidth={1.75} />
              {t.settings.envSectionTitle}
            </p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.settings.envSectionDescription}</p>
          </div>
          <div className="flex flex-none items-center gap-3">
            <button
              onClick={() => setPasteOpen(true)}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:opacity-85"
            >
              <ClipboardPaste size={14} strokeWidth={1.75} />
              {t.settings.pasteEnvButton}
            </button>
            <button
              onClick={() => setRevealAll((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
            >
              {revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
              {revealAll ? t.settings.hideValues : t.settings.showValues}
            </button>
          </div>
        </div>

        {envLoading ? (
          <p className="text-[13px] text-muted-foreground">{t.common.loading}</p>
        ) : (
          <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <div className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    value={row.key}
                    onChange={(e) => updateRow(index, "key", e.target.value.toUpperCase())}
                    placeholder={t.settings.keyPlaceholder}
                    spellCheck={false}
                    className="w-64 flex-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
                  />
                  <input
                    type={revealAll ? "text" : "password"}
                    value={row.value}
                    onChange={(e) => updateRow(index, "value", e.target.value)}
                    placeholder={t.settings.valuePlaceholder}
                    spellCheck={false}
                    className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
                  />
                  <button
                    onClick={() => removeRow(index)}
                    aria-label={t.settings.removeVarAriaLabel}
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
              {t.settings.addVarButton}
            </button>
          </div>
        )}

        {envError && <p className="mt-3 text-[13px] text-destructive">{envError}</p>}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSaveEnv}
            disabled={saving || envLoading}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} strokeWidth={1.75} />}
            {t.settings.saveVarsButton}
          </button>
          {saved && <span className="text-[12.5px] text-accent">{t.settings.saved}</span>}
        </div>
      </div>

      {confirmDetach && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !detaching && setConfirmDetach(false)}
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
                <p className="text-[14.5px] font-semibold text-foreground">{t.settings.confirmDetachTitle}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t.settings.confirmDetachBody}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDetach(false)}
                disabled={detaching}
                className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleDetach}
                disabled={detaching}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {detaching && <Loader2 size={14} className="animate-spin" />}
                {t.settings.detachButton}
              </button>
            </div>
          </div>
        </div>
      )}

      {pasteOpen && (
        <PasteEnvModal
          title={t.settings.pasteEnvTitle}
          description={t.settings.pasteEnvDescription}
          placeholder={t.settings.pasteEnvPlaceholder}
          importLabel={t.settings.pasteEnvImportButton}
          cancelLabel={t.common.cancel}
          onImport={handlePasteImport}
          onClose={() => setPasteOpen(false)}
        />
      )}
    </div>
  );
}
