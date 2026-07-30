"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, FolderGit2, ShieldHalf, ShieldCheck, SquareTerminal, LogOut, Search } from "lucide-react";
import { apiFetch } from "../lib/api-client";
import { useTranslation } from "../lib/i18n/locale-provider";
import { ThemeToggle } from "./theme-toggle";
import { LanguageToggle } from "./language-toggle";
import { CommandPalette, COMMAND_PALETTE_OPEN_EVENT } from "./command-palette";

function Logo() {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-accent font-mono text-[14px] font-semibold text-accent-foreground">
        &gt;_
      </div>
      <span className="text-[16px] font-semibold tracking-tight text-foreground">Korrelo</span>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const [username, setUsername] = useState<string | null>(null);
  const [isMac, setIsMac] = useState(false);

  const NAV_ITEMS = [
    { href: "/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
    { href: "/projects", label: t.nav.projects, icon: FolderGit2 },
    { href: "/system-services", label: t.nav.systemServices, icon: ShieldHalf },
    { href: "/terminal", label: t.nav.systemTerminal, icon: SquareTerminal },
    { href: "/security", label: t.nav.security, icon: ShieldCheck },
  ];

  useEffect(() => {
    apiFetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { username: string | null } | null) => setUsername(data?.username ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // navigator só existe no cliente, depois do hydrate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
  }, []);

  function openCommandPalette() {
    window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
  }

  async function handleLogout() {
    await apiFetch("/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const isFullHeightPage = pathname?.includes("/terminal") || pathname?.includes("/files");

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-72 flex-none flex-col gap-9 border-r border-border-subtle bg-surface px-5 py-7">
        <Logo />

        <button
          onClick={openCommandPalette}
          className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle px-3.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <span className="flex items-center gap-2">
            <Search size={15} strokeWidth={1.75} className="flex-none" />
            {t.nav.search}
          </span>
          <kbd className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[11px]">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>

        <nav className="flex flex-col gap-1.5">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] font-medium transition-colors ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <Icon size={18} strokeWidth={1.75} className="flex-none" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3 border-t border-border-subtle pt-5">
          {username && (
            <div className="flex items-center gap-2.5 px-3.5 text-[13px] text-muted-foreground">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              <span className="truncate">{username}</span>
            </div>
          )}
          <ThemeToggle />
          <LanguageToggle />
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <LogOut size={18} strokeWidth={1.75} className="flex-none" />
            {t.nav.logout}
          </button>
        </div>
      </aside>

      <main className={`min-h-0 min-w-0 flex-1 ${isFullHeightPage ? "flex flex-col" : "overflow-y-auto"}`}>
        {children}
      </main>

      <CommandPalette />
    </div>
  );
}
