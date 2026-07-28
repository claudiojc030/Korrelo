"use client";

import { Github } from "lucide-react";
import { apiFetch } from "../lib/api-client";

export function GithubConnectButton() {
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
      Conectar GitHub
    </button>
  );
}
