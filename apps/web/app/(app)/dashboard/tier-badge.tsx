"use client";

import { useState } from "react";
import type { ResourceTier } from "@korrelo/shared-types";
import { useTranslation } from "../../../lib/i18n/locale-provider";

export function TierBadge({ tier, label }: { tier: ResourceTier; label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const TIER_ROWS: { tier: ResourceTier; label: string; ram: string; containerLimit: string }[] = [
    { tier: "nano", label: t.dashboard.tierNano, ram: t.dashboard.tierRamUpTo1, containerLimit: "256 MB" },
    { tier: "micro", label: t.dashboard.tierMicro, ram: t.dashboard.tierRamUpTo4, containerLimit: "512 MB" },
    { tier: "small", label: t.dashboard.tierSmall, ram: t.dashboard.tierRamUpTo8, containerLimit: "768 MB" },
    { tier: "medium", label: t.dashboard.tierMedium, ram: t.dashboard.tierRamUpTo16, containerLimit: "1024 MB" },
    { tier: "large", label: t.dashboard.tierLarge, ram: t.dashboard.tierRamAbove16, containerLimit: "2048 MB" },
  ];

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="cursor-default rounded-full border border-border-subtle bg-surface px-3 py-1 text-[12px] font-medium text-muted-foreground">
        {t.dashboard.tierLabel} {label}
      </span>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-xl border border-border-subtle bg-surface p-3 shadow-panel">
          <p className="mb-2 px-1 text-[12px] text-muted-foreground">{t.dashboard.tierPopoverIntro}</p>
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                <th className="pb-1.5 pl-1 font-medium">{t.dashboard.tierColTier}</th>
                <th className="pb-1.5 font-medium">{t.dashboard.tierColRam}</th>
                <th className="pb-1.5 pr-1 font-medium">{t.dashboard.tierColLimit}</th>
              </tr>
            </thead>
            <tbody>
              {TIER_ROWS.map((row) => {
                const isCurrent = row.tier === tier;
                return (
                  <tr
                    key={row.tier}
                    className={`border-t border-border-subtle ${isCurrent ? "text-accent" : "text-foreground"}`}
                  >
                    <td className="py-1.5 pl-1 font-medium">
                      {row.label}
                      {isCurrent && <span className="ml-1.5 text-[10.5px]">{t.dashboard.tierYou}</span>}
                    </td>
                    <td className="py-1.5 font-mono">{row.ram}</td>
                    <td className="py-1.5 pr-1 font-mono">{row.containerLimit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
