type Severity = "good" | "warning" | "critical";

// Paleta de status fixa (nunca reaproveitada como cor categórica) — ver skill de dataviz.
const SEVERITY_COLOR: Record<Severity, string> = {
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

function severityOf(percent: number): Severity {
  if (percent >= 85) return "critical";
  if (percent >= 60) return "warning";
  return "good";
}

export function MetricTile({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const severity = severityOf(percent);
  const color = SEVERITY_COLOR[severity];

  return (
    <div className="rounded-md border border-neutral-800 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm text-neutral-400">{label}</span>
      </div>
      <p className="mt-1 text-2xl font-semibold text-neutral-100">{percent}%</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }}
        />
      </div>
      <p className="mt-1 text-xs text-neutral-500">{detail}</p>
    </div>
  );
}
