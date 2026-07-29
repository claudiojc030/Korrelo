"use client";

import { useState } from "react";
import type { ResourceTier } from "@forgedesk/shared-types";

const TIER_ROWS: { tier: ResourceTier; label: string; ram: string; containerLimit: string }[] = [
  { tier: "nano", label: "Nano", ram: "até 1 GB", containerLimit: "256 MB" },
  { tier: "micro", label: "Micro", ram: "até 4 GB", containerLimit: "512 MB" },
  { tier: "small", label: "Pequeno", ram: "até 8 GB", containerLimit: "768 MB" },
  { tier: "medium", label: "Médio", ram: "até 16 GB", containerLimit: "1024 MB" },
  { tier: "large", label: "Grande", ram: "acima de 16 GB", containerLimit: "2048 MB" },
];

export function TierBadge({ tier, label }: { tier: ResourceTier; label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="cursor-default rounded-full border border-border-subtle bg-surface px-3 py-1 text-[12px] font-medium text-muted-foreground">
        Porte {label}
      </span>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-xl border border-border-subtle bg-surface p-3 shadow-panel">
          <p className="mb-2 px-1 text-[12px] text-muted-foreground">
            Porte classificado pela RAM total da VPS — define o limite de memória por
            container de projeto implantado.
          </p>
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                <th className="pb-1.5 pl-1 font-medium">Porte</th>
                <th className="pb-1.5 font-medium">RAM da VPS</th>
                <th className="pb-1.5 pr-1 font-medium">Limite / container</th>
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
                      {isCurrent && <span className="ml-1.5 text-[10.5px]">(você)</span>}
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
