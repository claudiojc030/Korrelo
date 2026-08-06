"use client";

import { useState } from "react";
import { X, Loader2 } from "lucide-react";

export function PasteEnvModal({
  title,
  description,
  placeholder,
  importLabel,
  cancelLabel,
  onImport,
  onClose,
}: {
  title: string;
  description: string;
  placeholder: string;
  importLabel: string;
  cancelLabel: string;
  onImport: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    if (!text.trim()) return;
    setImporting(true);
    setError(null);
    try {
      await onImport(text);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={() => !importing && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-border-subtle bg-surface p-5 shadow-panel"
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-[14.5px] font-semibold text-foreground">{title}</h2>
          <button onClick={onClose} className="flex-none text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-[12.5px] text-muted-foreground">{description}</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={10}
          spellCheck={false}
          className="w-full resize-none rounded-md border border-border-subtle bg-background px-3 py-2 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-accent"
        />

        {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleImport}
            disabled={importing || !text.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {importing && <Loader2 size={14} className="animate-spin" />}
            {importLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
