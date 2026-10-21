/**
 * PÁGINA DE ARMAZENAMENTO (rota própria) + SIDEBAR.
 *
 * A auditoria/limpeza de armazenamento foi movida do Dashboard para uma
 * página própria (/storage), acessível pela sidebar.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildNavItems } from "../lib/nav-items";
import {
  canCleanSafeItems,
  filterStorageItems,
  formatStorageBytes,
  hasRemovableAction,
  storageCategoryKey,
  type StorageItemLike,
} from "../lib/storage-view";
import { navEn, navPt } from "../lib/i18n/dictionaries/nav";
import { storageEn, storagePt } from "../lib/i18n/dictionaries/storage";

const WEB_ROOT = path.resolve(__dirname, "..");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relative), "utf-8");
}

const ITENS: StorageItemLike[] = [
  {
    id: "docker:builder-cache",
    category: "docker",
    label: "Cache de build (BuildKit)",
    bytes: 2_800_000_000,
    classification: "SAFE_TO_CLEAN",
    reason: "Cache regenerável.",
    proposedAction: "docker-builder-cache",
    command: "docker builder prune -f --reserved-space 2GB",
    detail: null,
  },
  {
    id: "docker:image:abc",
    category: "docker",
    label: "Imagem de deploy antiga",
    bytes: 1_100_000_000,
    classification: "REVIEW",
    reason: "Commit antigo, sem container.",
    proposedAction: "docker-old-commit-images",
    command: "docker image rm <referencia>",
    detail: "korrelo-mesatta:commit-111122223333",
  },
  {
    id: "docker:image:def",
    category: "docker",
    label: "Imagem CURRENT do Mesatta",
    bytes: 1_800_000_000,
    classification: "NEVER_TOUCH",
    reason: "Imagem CURRENT em producao.",
    proposedAction: null,
    command: null,
    detail: "korrelo-mesatta:commit-a1b2c3d4e5f6",
  },
  {
    id: "docker:volume:uploads-data",
    category: "docker",
    label: "Volume uploads-data",
    bytes: 6_400_000_000,
    classification: "NEVER_TOUCH",
    reason: "Volume de uploads.",
    proposedAction: null,
    command: null,
    detail: "uploads-data",
  },
  {
    id: "korrelo:self-update:upd-1.log",
    category: "korrelo",
    label: "Log de self-update antigo",
    bytes: 1_000_000,
    classification: "SAFE_TO_CLEAN",
    reason: "Job antigo, ja concluído.",
    proposedAction: "self-update-old-logs",
    command: "rm -f ~/.korrelo/self-update/<job>.log",
    detail: "/home/korrelo/.korrelo/self-update/upd-1.log",
  },
  {
    id: "korrelo:backup:core-antigo.db",
    category: "korrelo",
    label: "Backup antigo do Core",
    bytes: 3_000_000,
    classification: "REVIEW",
    reason: "Backup com mais de 7 dias.",
    proposedAction: "korrelo-old-backups",
    command: "rm -f ~/korrelo-backups/<backup>.db",
    detail: "/home/korrelo/korrelo-backups/core-antigo.db",
  },
  {
    id: "system:npm-cache",
    category: "system",
    label: "Cache do npm",
    bytes: 500_000_000,
    classification: "SAFE_TO_CLEAN",
    reason: "Cache regeneravel.",
    proposedAction: "npm-cache",
    command: "npm cache clean --force",
    detail: "/home/korrelo/.npm/_cacache",
  },
  {
    id: "system:journald",
    category: "system",
    label: "Logs do journald",
    bytes: 300_000_000,
    classification: "REVIEW",
    reason: "Reduz com vacuum.",
    proposedAction: "journal-old",
    command: "journalctl --vacuum-size=200M",
    detail: "/var/log/journal",
  },
];

describe("sidebar - Armazenamento como item de primeiro nível", () => {
  const labels = {
    dashboard: "Dashboard",
    projects: "Projetos",
    systemServices: "Serviços do servidor",
    systemTerminal: "Terminal da VPS",
    storage: "Armazenamento",
    security: "Segurança",
    settings: "Configurações",
  };

  it("1) a sidebar renderiza 'Armazenamento'", () => {
    const items = buildNavItems(labels);
    expect(items.some((item) => item.label === "Armazenamento")).toBe(true);
    expect(items.some((item) => item.href === "/storage")).toBe(true);
  });

  it("2) ordem: Terminal da VPS -> Armazenamento -> Segurança", () => {
    const items = buildNavItems(labels);
    const hrefs = items.map((item) => item.href);
    expect(hrefs).toEqual([
      "/dashboard",
      "/projects",
      "/system-services",
      "/terminal",
      "/storage",
      "/security",
      "/settings",
    ]);
    const terminal = hrefs.indexOf("/terminal");
    const storage = hrefs.indexOf("/storage");
    const security = hrefs.indexOf("/security");
    expect(terminal).toBeLessThan(storage);
    expect(storage).toBeLessThan(security);
  });

  it("3) 'Armazenamento' NÃO fica dentro de 'Serviços do servidor'", () => {
    const items = buildNavItems(labels);
    // É item de primeiro nível (href próprio), não uma sub-rota.
    const storage = items.find((item) => item.href === "/storage");
    expect(storage).toBeDefined();
    expect(storage?.href.startsWith("/system-services")).toBe(false);
  });

  it("4) o item ativo é detectado pelo mesmo prefixo usado no app-shell", () => {
    const items = buildNavItems(labels);
    const isActive = (pathname: string) =>
      items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
    expect(isActive("/storage")).toBe(true);
    expect(isActive("/security")).toBe(true);
    expect(isActive("/projects")).toBe(true);
    expect(isActive("/storage/extra")).toBe(true);
  });

  it("5) o app-shell usa a lista de navegação (fonte única)", () => {
    const source = readSource("components/app-shell.tsx");
    expect(source).toContain("buildNavItems");
    // A rota em si mora na lista compartilhada (ver itens 1-3).
    expect(source).toContain("t.nav.storage");
  });
});

describe("página /storage", () => {
  it("6) a rota existe e é uma página dedicada", () => {
    const page = readSource("app/(app)/storage/page.tsx");
    expect(page).toContain("StoragePanel");
    expect(page).toContain("t.storage.pageTitle");
    expect(page).toContain("t.storage.pageDescription");
  });

  it("7) o Dashboard NÃO renderiza mais a auditoria de armazenamento", () => {
    const dashboard = readSource("app/(app)/dashboard/page.tsx");
    expect(dashboard).not.toContain("StoragePanel");
    expect(dashboard).not.toContain("/monitoring/storage");
    // O painel antigo saiu do diretório do dashboard.
    expect(fs.existsSync(path.join(WEB_ROOT, "app/(app)/dashboard/storage-panel.tsx"))).toBe(false);
  });

  it("8) o card de Disco tem o link discreto para /storage", () => {
    const dashboard = readSource("app/(app)/dashboard/page.tsx");
    expect(dashboard).toContain('href: "/storage"');
    expect(dashboard).toContain("t.dashboard.viewStorage");
  });

  it("9) a página carrega a auditoria e tem os botões de ação", () => {
    const panel = readSource("app/(app)/storage/storage-panel.tsx");
    expect(panel).toContain("/monitoring/storage");
    expect(panel).toContain("/monitoring/storage/clean");
    // Os botões usam as traduções da página de armazenamento.
    expect(panel).toContain("s.analyze");
    expect(panel).toContain("s.clean");
  });
});

describe("filtros e listagem", () => {
  it("10) filtro por classificação funciona", () => {
    const safe = filterStorageItems(ITENS, { classification: "SAFE_TO_CLEAN" });
    expect(safe.length).toBeGreaterThan(0);
    for (const item of safe) expect(item.classification).toBe("SAFE_TO_CLEAN");

    const never = filterStorageItems(ITENS, { classification: "NEVER_TOUCH" });
    expect(never.length).toBeGreaterThan(0);
    for (const item of never) expect(item.classification).toBe("NEVER_TOUCH");

    const review = filterStorageItems(ITENS, { classification: "REVIEW" });
    expect(review.length).toBeGreaterThan(0);

    expect(filterStorageItems(ITENS, { classification: "ALL" })).toHaveLength(ITENS.length);
  });

  it("11) filtro por categoria funciona", () => {
    const docker = filterStorageItems(ITENS, { category: "docker" });
    expect(docker.length).toBeGreaterThan(0);
    for (const item of docker) expect(storageCategoryKey(item)).toBe("docker");

    expect(filterStorageItems(ITENS, { category: "backups" }).length).toBeGreaterThan(0);
    expect(filterStorageItems(ITENS, { category: "caches" }).length).toBeGreaterThan(0);
    expect(filterStorageItems(ITENS, { category: "ALL" })).toHaveLength(ITENS.length);
  });

  it("12) filtros combinados funcionam", () => {
    const resultado = filterStorageItems(ITENS, { classification: "SAFE_TO_CLEAN", category: "docker" });
    for (const item of resultado) {
      expect(item.classification).toBe("SAFE_TO_CLEAN");
      expect(storageCategoryKey(item)).toBe("docker");
    }
  });

  it("13) NEVER TOUCH nunca oferece ação de remoção", () => {
    for (const item of ITENS.filter((i) => i.classification === "NEVER_TOUCH")) {
      expect(hasRemovableAction(item)).toBe(false);
      expect(item.proposedAction).toBeNull();
    }
  });

  it("14) REVIEW aparece mas não é removível automaticamente", () => {
    const review = ITENS.filter((i) => i.classification === "REVIEW");
    expect(review.length).toBeGreaterThan(0);
    // Tem proposta (informativa), mas não é SAFE -> não entra na limpeza.
    for (const item of review) {
      expect(hasRemovableAction(item)).toBe(false);
    }
  });

  it("15) cleanup desabilitado quando não há item SAFE", () => {
    expect(canCleanSafeItems([])).toBe(false);
    expect(canCleanSafeItems(undefined)).toBe(false);
    expect(canCleanSafeItems([{ id: "docker-builder-cache", items: [{}] }])).toBe(true);
  });
});

describe("formatação", () => {
  it("16) bytes em unidade legível", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatStorageBytes(2_800_000_000)).toBe("2.6 GB");
  });
});

describe("traduções", () => {
  it("17) pt-BR e en têm as strings da página e da sidebar", () => {
    expect(storagePt.pageTitle).toBe("Armazenamento");
    expect(storageEn.pageTitle).toBe("Storage");
    expect(navPt.storage).toBe("Armazenamento");
    expect(navEn.storage).toBe("Storage");
    // A descrição pedida.
    expect(storagePt.pageDescription).toContain("Analise o uso de disco da VPS");
    expect(storageEn.pageDescription).toContain("Analyze the VPS disk usage");
  });

  it("18) as traduções têm as mesmas chaves em pt e en", () => {
    expect(Object.keys(storagePt).sort()).toEqual(Object.keys(storageEn).sort());
  });

  it("19) os badges de classificação existem nos dois idiomas", () => {
    for (const dict of [storagePt, storageEn]) {
      expect(dict.badgeSafe.length).toBeGreaterThan(0);
      expect(dict.badgeReview.length).toBeGreaterThan(0);
      expect(dict.badgeKeep.length).toBeGreaterThan(0);
      expect(dict.badgeNever.length).toBeGreaterThan(0);
    }
  });
});
