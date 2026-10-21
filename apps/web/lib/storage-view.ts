/**
 * LÓGICA DA PÁGINA DE ARMAZENAMENTO (funções puras, testáveis).
 *
 * O componente React fica só com a apresentação; aqui mora o que dá para
 * testar sem navegador: filtro de classificação, categoria de cada item,
 * formatação de tamanho e a regra de "pode limpar".
 */

export type StorageClassification = "SAFE_TO_CLEAN" | "REVIEW" | "KEEP" | "NEVER_TOUCH";

/** Categorias mostradas no filtro. */
export type StorageCategoryKey =
  | "docker"
  | "buildCache"
  | "backups"
  | "selfUpdate"
  | "logs"
  | "caches"
  | "temp"
  | "other";

export interface StorageItemLike {
  id: string;
  category: string;
  label: string;
  bytes: number;
  classification: StorageClassification;
  reason: string;
  proposedAction: string | null;
  command: string | null;
  detail: string | null;
}

/**
 * Categoria de exibição de um item.
 *
 * O backend manda "docker"/"korrelo"/"system"; aqui isso vira o que o
 * operador entende (Docker, Backups, Logs, Caches...).
 */
export function storageCategoryKey(item: StorageItemLike): StorageCategoryKey {
  const id = item.id;
  if (id.startsWith("docker:builder-cache")) return "buildCache";
  if (id.startsWith("docker:")) return "docker";
  if (id.startsWith("korrelo:backup")) return "backups";
  if (id.startsWith("korrelo:artifact-snapshot")) return "backups";
  if (id.startsWith("korrelo:self-update")) return "selfUpdate";
  if (id.startsWith("korrelo:pm2-logs")) return "logs";
  if (id.startsWith("korrelo:workspace")) return "other";
  if (id.startsWith("system:npm-cache")) return "caches";
  if (id.startsWith("system:apt-cache")) return "caches";
  if (id.startsWith("system:journald")) return "logs";
  if (id.startsWith("system:temp")) return "temp";
  return "other";
}

/** Aplica o filtro de classificação e o de categoria. */
export function filterStorageItems(
  items: StorageItemLike[],
  filters: { classification?: StorageClassification | "ALL"; category?: StorageCategoryKey | "ALL" },
): StorageItemLike[] {
  return items.filter((item) => {
    if (filters.classification && filters.classification !== "ALL") {
      if (item.classification !== filters.classification) return false;
    }
    if (filters.category && filters.category !== "ALL") {
      if (storageCategoryKey(item) !== filters.category) return false;
    }
    return true;
  });
}

/** Um item protegido (NEVER_TOUCH) NUNCA tem ação de remoção. */
export function hasRemovableAction(item: StorageItemLike): boolean {
  return item.classification === "SAFE_TO_CLEAN" && item.proposedAction !== null;
}

/**
 * "Limpar itens seguros" só é habilitado quando existe ao menos um item
 * SAFE (o backend devolve as ações disponíveis em `actions`).
 */
export function canCleanSafeItems(actions: { id: string; items: unknown[] }[] | undefined): boolean {
  return Array.isArray(actions) && actions.length > 0;
}

/** Formata bytes em unidade legível. */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
