"use client";

import { useEffect, useRef, useState } from "react";
import { Github, Loader2 } from "lucide-react";
import { apiFetch, API_URL } from "../lib/api-client";
import { useTranslation } from "../lib/i18n/locale-provider";

interface GithubStatus {
  connected: boolean;
  accountLogin: string | null;
  appConfigured: boolean;
}

export function GithubConnectButton() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const manifestInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/github/status")
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function handleConnectClick() {
    const res = await apiFetch("/github/install-url");
    const { url } = (await res.json()) as { url: string };
    window.location.href = url;
  }

  function handleCreateAppClick() {
    // Fluxo de "manifest" do GitHub: preenche nome/permissões/webhook de
    // antemão e submete um form de verdade pro github.com (não dá pra fazer
    // via fetch/CORS). O GitHub cria o App, redireciona de volta com um
    // "code" de uso único, e o backend troca isso pelas credenciais reais
    // (ver /github/manifest-callback) — sem copiar App ID/chave na mão.
    const suffix = Math.random().toString(36).slice(2, 6);
    const webUrl = window.location.origin;
    const manifest = {
      name: `korrelo-${suffix}`,
      url: webUrl,
      hook_attributes: { url: `${API_URL}/github/webhook` },
      redirect_url: `${API_URL}/github/manifest-callback`,
      callback_urls: [webUrl],
      public: false,
      default_permissions: { contents: "read", metadata: "read" },
      default_events: ["push"],
    };

    if (manifestInputRef.current) {
      manifestInputRef.current.value = JSON.stringify(manifest);
    }
    formRef.current?.submit();
  }

  if (!status) {
    return (
      <button
        disabled
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background opacity-60"
      >
        <Loader2 size={16} className="animate-spin" />
      </button>
    );
  }

  if (!status.appConfigured) {
    return (
      <>
        <form ref={formRef} method="post" action="https://github.com/settings/apps/new" className="hidden">
          <input ref={manifestInputRef} type="hidden" name="manifest" />
        </form>
        <button
          onClick={handleCreateAppClick}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          <Github size={16} strokeWidth={2} />
          {t.nav.createGithubApp}
        </button>
      </>
    );
  }

  return (
    <button
      onClick={handleConnectClick}
      className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
    >
      <Github size={16} strokeWidth={2} />
      {t.nav.connectGithub}
    </button>
  );
}
