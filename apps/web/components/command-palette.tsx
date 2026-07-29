"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderGit2,
  ShieldHalf,
  ShieldCheck,
  FolderKanban,
  Search,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { apiFetch } from "../lib/api-client";

export const COMMAND_PALETTE_OPEN_EVENT = "korrelo:open-command-palette";

interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
  href: string;
  icon: LucideIcon;
}

const STATIC_ITEMS: PaletteItem[] = [
  { id: "nav-dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { id: "nav-projects", label: "Projetos", href: "/projects", icon: FolderGit2 },
  { id: "nav-services", label: "Serviços do servidor", href: "/system-services", icon: ShieldHalf },
  { id: "nav-security", label: "Segurança", href: "/security", icon: ShieldCheck },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isMod = event.metaKey || event.ctrlKey;
      if (isMod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key === "Escape" && open) {
        setOpen(false);
      }
    }
    function handleOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handleOpenEvent);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());

    apiFetch("/projects")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: { id: string; name: string }[]) => setProjects(data))
      .catch(() => setProjects([]));
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const projectItems: PaletteItem[] = projects.map((project) => ({
      id: `project-${project.id}`,
      label: project.name,
      sublabel: "Projeto",
      href: `/projects/${project.id}`,
      icon: FolderKanban,
    }));
    return [...STATIC_ITEMS, ...projectItems];
  }, [projects]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => item.label.toLowerCase().includes(normalized));
  }, [items, query]);

  function navigateTo(item: PaletteItem) {
    setOpen(false);
    router.push(item.href);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[selectedIndex];
      if (item) navigateTo(item);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-panel"
      >
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <Search size={16} strokeWidth={1.75} className="flex-none text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Ir pra..."
            className="w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <kbd className="flex-none rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">Nada encontrado.</p>
          ) : (
            filtered.map((item, index) => {
              const Icon = item.icon;
              const active = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => navigateTo(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[13.5px] transition-colors ${
                    active ? "bg-muted text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon size={16} strokeWidth={1.75} className="flex-none" />
                    {item.label}
                  </span>
                  <span className="flex items-center gap-2">
                    {item.sublabel && <span className="text-[11px] text-muted-foreground/70">{item.sublabel}</span>}
                    {active && <CornerDownLeft size={13} strokeWidth={1.75} className="flex-none" />}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
