"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: `/projects/${projectId}`, label: "Resumo" },
    { href: `/projects/${projectId}/env`, label: "Variáveis de Ambiente" },
    { href: `/projects/${projectId}/terminal`, label: "Terminal" },
  ];

  return (
    <div className="flex gap-5 px-8">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`border-b-2 py-2.5 text-[13.5px] font-medium transition-colors ${
              active
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
