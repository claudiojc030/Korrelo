"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, FolderGit2, LogOut } from "lucide-react";
import { getTokenClient, clearTokenClient } from "../lib/auth-cookie-client";
import { decodeJwtEmail } from "../lib/decode-jwt";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projetos", icon: FolderGit2 },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-mono text-[13px] font-semibold text-accent-foreground">
        &gt;_
      </div>
      <span className="text-[15px] font-semibold tracking-tight text-foreground">ForgeDesk</span>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    setEmail(decodeJwtEmail(getTokenClient()));
  }, []);

  function handleLogout() {
    clearTokenClient();
    router.push("/login");
    router.refresh();
  }

  const isTerminal = pathname?.includes("/terminal");

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 flex-none flex-col gap-6 border-r border-border-subtle bg-surface px-3 py-5">
        <Logo />

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <Icon size={17} strokeWidth={1.75} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-4">
          {email && (
            <div className="flex items-center gap-2 px-3 text-[12.5px] text-muted-foreground">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              <span className="truncate">{email}</span>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <LogOut size={17} strokeWidth={1.75} />
            Sair
          </button>
        </div>
      </aside>

      <main className={`min-w-0 flex-1 ${isTerminal ? "flex flex-col" : "overflow-y-auto"}`}>
        {children}
      </main>
    </div>
  );
}
