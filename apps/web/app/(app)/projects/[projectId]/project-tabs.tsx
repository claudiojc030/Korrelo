"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "../../../../lib/i18n/locale-provider";

export function ProjectTabs({
  projectId,
  terminalEnabled,
  databaseEnabled,
}: {
  projectId: string;
  terminalEnabled: boolean;
  databaseEnabled: boolean;
}) {
  const pathname = usePathname();
  const { t } = useTranslation();
  const tabs = [
    { href: `/projects/${projectId}`, label: t.projectDetail.tabSummary },
    { href: `/projects/${projectId}/env`, label: t.projectDetail.tabEnvVars },
    ...(databaseEnabled ? [{ href: `/projects/${projectId}/database`, label: t.projectDetail.tabDatabase }] : []),
    ...(terminalEnabled ? [{ href: `/projects/${projectId}/terminal`, label: t.projectDetail.tabTerminal }] : []),
    { href: `/projects/${projectId}/logs`, label: t.projectDetail.tabLogs },
    { href: `/projects/${projectId}/files`, label: t.projectDetail.tabFiles },
    { href: `/projects/${projectId}/cron`, label: t.projectDetail.tabCron },
    { href: `/projects/${projectId}/settings`, label: t.projectDetail.tabSettings },
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
