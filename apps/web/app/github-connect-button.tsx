"use client";

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
      className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
    >
      Conectar GitHub
    </button>
  );
}
