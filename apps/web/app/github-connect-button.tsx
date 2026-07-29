"use client";

import { Github } from "lucide-react";
import { apiFetch } from "../lib/api-client";
import { useTranslation } from "../lib/i18n/locale-provider";

export function GithubConnectButton() {
  const { t } = useTranslation();

  async function handleClick() {
    const res = await apiFetch("/github/install-url");
    const { url } = (await res.json()) as { url: string };
    window.location.href = url;
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
    >
      <Github size={16} strokeWidth={2} />
      {t.nav.connectGithub}
    </button>
  );
}
