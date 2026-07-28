"use client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function GithubConnectButton() {
  async function handleClick() {
    const res = await fetch(`${API_URL}/github/install-url`);
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
