import dynamic from "next/dynamic";
import { SquareSlash } from "lucide-react";
import type { Project } from "@korrelo/shared-types";
import { authHeaderServer } from "../../../../../lib/auth-cookie-server";
import { getLocaleServer } from "../../../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../../../lib/i18n/dictionaries";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TerminalClient = dynamic(
  () => import("./terminal-client").then((mod) => mod.TerminalClient),
  { ssr: false },
);

async function getProject(projectId: string): Promise<Project | null> {
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}`, {
      cache: "no-store",
      headers: await authHeaderServer(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function TerminalPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const t = getDictionary(await getLocaleServer());
  const project = await getProject(params.projectId);

  if (project && !project.terminalEnabled) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-2 px-8 py-6 text-center">
        <SquareSlash size={20} strokeWidth={1.75} className="text-muted-foreground" />
        <p className="text-[13.5px] font-medium text-foreground">{t.projectTerminal.disabledTitle}</p>
        <p className="text-[12.5px] text-muted-foreground">
          {t.projectTerminal.disabledDescription}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 p-4">
      <TerminalClient projectId={params.projectId} />
    </div>
  );
}
