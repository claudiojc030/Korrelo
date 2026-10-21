import type { LucideIcon } from "lucide-react";
import Link from "next/link";

type Severity = "good" | "warning" | "critical" | "unknown";

const SEVERITY_STYLE: Record<Severity, string> = {
  good: "bg-accent",
  warning: "bg-warning",
  critical: "bg-destructive",
  // Sem medição válida: estado NEUTRO (nada de vermelho/verde falso).
  unknown: "bg-muted-foreground/40",
};

function severityOf(percent: number): Severity {
  if (percent >= 85) return "critical";
  if (percent >= 60) return "warning";
  return "good";
}

export function MetricTile({
  label,
  icon: Icon,
  percent,
  detail,
  /** Texto mostrado quando não há medição válida (ex.: "Coletando..."). */
  pendingLabel,
  /** Link discreto no rodapé do card (ex.: "Ver armazenamento"). */
  action,
}: {
  label: string;
  icon: LucideIcon;
  percent: number | null;
  detail: string;
  pendingLabel?: string;
  action?: { href: string; label: string };
}) {
  const hasMeasurement = percent !== null && percent !== undefined;
  const fill = SEVERITY_STYLE[hasMeasurement ? severityOf(percent) : "unknown"];

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon size={15} strokeWidth={1.75} />
          <span className="text-[13px] font-medium">{label}</span>
        </div>
        <span className={`h-1.5 w-1.5 rounded-full ${fill}`} />
      </div>
      {hasMeasurement ? (
        <>
          <p className="mt-3 font-mono text-[26px] font-semibold leading-none text-foreground">
            {percent}
            <span className="text-[15px] text-muted-foreground">%</span>
          </p>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${fill}`}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
        </>
      ) : (
        <>
          {/* Sem medição válida: nada de barra vermelha nem número inventado. */}
          <p className="mt-3 font-mono text-[26px] font-semibold leading-none text-muted-foreground">
            {pendingLabel ?? "—"}
          </p>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted" />
        </>
      )}
      <p className="mt-2 text-[12px] text-muted-foreground">{detail}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:opacity-85"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
