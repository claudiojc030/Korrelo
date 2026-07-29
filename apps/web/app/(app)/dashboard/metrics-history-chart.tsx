"use client";

import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { TrendingUp } from "lucide-react";
import { apiFetch } from "../../../lib/api-client";
import { useTranslation } from "../../../lib/i18n/locale-provider";

type Range = "1h" | "24h" | "7d";

interface HistoryPoint {
  capturedAt: string;
  cpuPercent: number;
  usedMemPercent: number;
  usedDiskPercent: number;
}

const RANGE_LABEL: Record<Range, string> = { "1h": "1h", "24h": "24h", "7d": "7d" };

function formatTimeTick(iso: string, range: Range, locale: "pt" | "en"): string {
  const date = new Date(iso);
  const bcp47 = locale === "en" ? "en-US" : "pt-BR";
  if (range === "7d") {
    return date.toLocaleDateString(bcp47, { day: "2-digit", month: "2-digit" });
  }
  return date.toLocaleTimeString(bcp47, { hour: "2-digit", minute: "2-digit" });
}

export function MetricsHistoryChart() {
  const { t, locale } = useTranslation();
  const [range, setRange] = useState<Range>("1h");
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setPoints(null);
    setError(false);
    apiFetch(`/monitoring/history?range=${range}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: HistoryPoint[]) => setPoints(data))
      .catch(() => setError(true));
  }, [range]);

  return (
    <div className="mt-8">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp size={15} strokeWidth={1.75} />
          <h2 className="text-[13px] font-medium">
            {t.dashboard.historyTitle} <span className="text-muted-foreground/60">· {t.dashboard.historySubtitle}</span>
          </h2>
        </div>
        <div className="flex gap-1 rounded-lg border border-border-subtle bg-surface p-0.5">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                range === r ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        {error ? (
          <p className="text-[13px] text-destructive">{t.dashboard.historyError}</p>
        ) : points === null ? (
          <p className="text-[13px] text-muted-foreground">{t.dashboard.historyLoading}</p>
        ) : points.length < 2 ? (
          <p className="text-[13px] text-muted-foreground">{t.dashboard.historyNotEnoughData}</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
              <XAxis
                dataKey="capturedAt"
                tickFormatter={(value) => formatTimeTick(value, range, locale)}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                axisLine={{ stroke: "var(--color-border-subtle)" }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <Tooltip
                labelFormatter={(value) => formatTimeTick(String(value), range, locale)}
                formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                contentStyle={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 8,
                  fontSize: 12.5,
                }}
              />
              <Line type="monotone" dataKey="cpuPercent" name={t.dashboard.cpu} stroke="#f59e0b" dot={false} strokeWidth={1.75} />
              <Line
                type="monotone"
                dataKey="usedMemPercent"
                name={t.dashboard.memory}
                stroke="#3b82f6"
                dot={false}
                strokeWidth={1.75}
              />
              <Line
                type="monotone"
                dataKey="usedDiskPercent"
                name={t.dashboard.disk}
                stroke="#10b981"
                dot={false}
                strokeWidth={1.75}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
