"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, FolderGit2, ShieldHalf, ShieldCheck, LogOut } from "lucide-react";
import { apiFetch } from "../lib/api-client";
import { ThemeToggle } from "./theme-toggle";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projetos", icon: FolderGit2 },
  { href: "/system-services", label: "Serviços do servidor", icon: ShieldHalf },
  { href: "/security", label: "Segurança", icon: ShieldCheck },
];

function Logo() {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-accent font-mono text-[14px] font-semibold text-accent-foreground">
        &gt;_
      </div>
      <span className="text-[16px] font-semibold tracking-tight text-foreground">ForgeDesk</span>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { email: string | null } | null) => setEmail(data?.email ?? null))
      .catch(() => {});
  }, []);

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
          {email && (
            <div className="flex items-center gap-2.5 px-3.5 text-[13px] text-muted-foreground">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              <span className="truncate">{email}</span>
            </div>
          )}
          <ThemeToggle />
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <LogOut size={18} strokeWidth={1.75} className="flex-none" />
            Sair
          </button>
        </div>
      </aside>

      <main className={`min-h-0 min-w-0 flex-1 ${isFullHeightPage ? "flex flex-col" : "overflow-y-auto"}`}>
        {children}
      </main>
    </div>
  );
}
