import {
  LayoutDashboard,
  FolderGit2,
  ShieldHalf,
  ShieldCheck,
  SquareTerminal,
  Settings,
  HardDrive,
  type LucideIcon,
} from "lucide-react";

/**
 * ITENS DE PRIMEIRO NÍVEL DA SIDEBAR.
 *
 * A ordem é FIXA e é o que o operador espera:
 *   Dashboard
 *   Projetos
 *   Serviços do servidor
 *   Terminal da VPS
 *   Armazenamento     <- página de storage
 *   Segurança
 *   Configurações
 *
 * "Armazenamento" fica abaixo de "Terminal da VPS" e acima de "Segurança"
 * (é onde a auditoria/limpeza de disco mora, longe do Dashboard que ficaria
 * longo demais).
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Rótulos da navegação (dependem do idioma). */
export interface NavLabels {
  dashboard: string;
  projects: string;
  systemServices: string;
  systemTerminal: string;
  storage: string;
  security: string;
  settings: string;
}

export function buildNavItems(labels: NavLabels): NavItem[] {
  return [
    { href: "/dashboard", label: labels.dashboard, icon: LayoutDashboard },
    { href: "/projects", label: labels.projects, icon: FolderGit2 },
    { href: "/system-services", label: labels.systemServices, icon: ShieldHalf },
    { href: "/terminal", label: labels.systemTerminal, icon: SquareTerminal },
    { href: "/storage", label: labels.storage, icon: HardDrive },
    { href: "/security", label: labels.security, icon: ShieldCheck },
    { href: "/settings", label: labels.settings, icon: Settings },
  ];
}
