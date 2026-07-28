import type { LucideIcon } from "lucide-react";

type Severity = "good" | "warning" | "critical";

const SEVERITY_STYLE: Record<Severity, string> = {
  good: "bg-accent",
  warning: "bg-warning",
  critical: "bg-destructive",
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
}: {
  label: string;
  icon: LucideIcon;
  percent: number;
  detail: string;
}) {
  const fill = SEVERITY_STYLE[severityOf(percent)];

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon size={15} strokeWidth={1.75} />
          <span className="text-[13px] font-medium">{label}</span>
        </div>
        <span className={`h-1.5 w-1.5 rounded-full ${fill}`} />
      </div>
      <p className="mt-3 font-mono text-[26px] font-semibold leading-none text-foreground">
        {percent}
        <span className="text-[15px] text-muted-foreground">%</span>
      </p>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">{detail}</p>
    </div>
  );
}
