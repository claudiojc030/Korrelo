/**
 * AUDITORIA E LIMPEZA DE ARMAZENAMENTO - tipos e allowlist.
 *
 * O Korrelo nunca vai apagar nada por conta própria: ele ANALISA (read-only)
 * e mostra o que é seguro, o que precisa de revisão e o que é PROIBIDO.
 * A limpeza só acontece por ação explícita do operador, e apenas para itens
 * de uma ALLOWLIST FECHADA (enum abaixo).
 *
 * NUNCA existe "path arbitrário vindo do frontend": o backend só executa
 * comandos que ELE constrói a partir da allowlist.
 */

export type StorageCategory = "disk" | "docker" | "korrelo" | "system";

export type StorageClassification =
  /** Regenerável e sem referência: pode ser limpo com segurança. */
  | "SAFE_TO_CLEAN"
  /** Pode ser limpo, mas precisa de decisão do operador. */
  | "REVIEW"
  /** Necessário para o funcionamento - não é lixo. */
  | "KEEP"
  /** PROIBIDO: produção, bancos, volumes, imagens de rollback, segredos. */
  | "NEVER_TOUCH";

/**
 * Ações de limpeza permitidas. Este enum É a allowlist: o frontend só
 * escolhe UM destes identificadores (nunca um comando ou um path).
 */
export type StorageActionId =
  | "docker-builder-cache"
  | "docker-dangling-images"
  | "docker-old-commit-images"
  | "self-update-old-logs"
  | "korrelo-old-artifact-backups"
  | "korrelo-old-backups"
  | "npm-cache"
  | "apt-cache"
  | "journal-old"
  | "temp-korrelo";

export interface StorageActionDefinition {
  id: StorageActionId;
  label: string;
  /** Comando técnico que SERIA executado (nunca executado sem confirmação). */
  command: string;
  /** A ação é destrutiva (apaga) ou só reorganiza? */
  destructive: boolean;
  /** Observação de segurança (por que é seguro, ou por que exige revisão). */
  note: string;
}

/**
 * ALLOWLIST FECHADA. Tudo que a limpeza pode fazer está aqui.
 *
 * PROIBIDOS (e ausentes de propósito): docker system prune -a,
 * docker volume prune, docker volume rm, docker compose down, rm -rf
 * /var/lib/docker, rm -rf uploads, systemctl stop docker, pm2 delete.
 */
export const STORAGE_ACTIONS: Record<StorageActionId, StorageActionDefinition> = {
  "docker-builder-cache": {
    id: "docker-builder-cache",
    label: "Cache de build antigo (BuildKit)",
    command: "docker builder prune -f --reserved-space 2GB",
    destructive: true,
    note: "Só o cache não-reutilizável é removido; o espaço reservado (2GB) é preservado e as imagens NÃO são tocadas.",
  },
  "docker-dangling-images": {
    id: "docker-dangling-images",
    label: "Imagens dangling (sem tag)",
    command: "docker image prune -f",
    destructive: true,
    note: "Apenas camadas sem tag e sem container associado. Imagens com tag (inclusive CURRENT e rollback) ficam.",
  },
  "docker-old-commit-images": {
    id: "docker-old-commit-images",
    label: "Imagens commit-<sha> antigas e sem referência",
    command: "docker image rm <referência-da-imagem-antiga>",
    destructive: true,
    note: "Só imagens que: não são a CURRENT, não são a anterior (rollback), não são a candidata do deploy em andamento e não têm container usando.",
  },
  "self-update-old-logs": {
    id: "self-update-old-logs",
    label: "Logs e jobs antigos do self-update",
    command: "rm -f ~/.korrelo/self-update/<job>.log|json|pid (mais de 7 dias)",
    destructive: true,
    note: "Preserva o job atual, o job em andamento e os resultados recentes (7 dias).",
  },
  "korrelo-old-artifact-backups": {
    id: "korrelo-old-artifact-backups",
    label: "Snapshots de artefatos do Core antigos",
    command: "rm -rf ~/korrelo-artifact-backups/<timestamp-antigo>",
    destructive: true,
    note: "Snapshots usados para restaurar o Core sem recompilar. O mais recente é preservado.",
  },
  "korrelo-old-backups": {
    id: "korrelo-old-backups",
    label: "Backups antigos do banco do Core",
    command: "rm -f ~/korrelo-backups/<backup-antigo>.db",
    destructive: true,
    note: "O backup mais recente é sempre preservado.",
  },
  "npm-cache": {
    id: "npm-cache",
    label: "Cache do npm",
    command: "npm cache clean --force",
    destructive: true,
    note: "Regenerável: o npm rebaixa o que for necessário no próximo build.",
  },
  "apt-cache": {
    id: "apt-cache",
    label: "Cache de pacotes do apt",
    command: "apt-get clean",
    destructive: true,
    note: "Só os .deb já baixados. Nenhum pacote instalado é removido.",
  },
  "journal-old": {
    id: "journal-old",
    label: "Logs antigos do journald",
    command: "journalctl --vacuum-size=200M",
    destructive: true,
    note: "Reduz o journal ao teto de 200MB. Não toca em nenhum serviço.",
  },
  "temp-korrelo": {
    id: "temp-korrelo",
    label: "Temporários do próprio Korrelo",
    command: "rm -rf /tmp/korrelo-* (mais de 7 dias)",
    destructive: true,
    note: "Só o que o Korrelo criou em /tmp. Arquivos de outros programas não são tocados.",
  },
};

/** Item individual encontrado na auditoria. */
export interface StorageItem {
  /** Identificador estável (usado como chave de UI). */
  id: string;
  category: StorageCategory;
  label: string;
  /** Tamanho em bytes (0 quando não se sabe). */
  bytes: number;
  /**
   * Bytes que contam para a classificação SAFE_TO_CLEAN.
   *
   * O padrão é o próprio `bytes`, mas existe para os itens em que ocupar
   * espaço e LIBERAR espaço são coisas diferentes: o cache de build ocupa
   * 10 GB, mas só 0 B (ou o que o Docker disser) é realmente liberável.
   * Sem essa distinção, o painel prometeria 10 GB de limpeza que o prune
   * nunca entrega.
   */
  safeBytes?: number;
  classification: StorageClassification;
  /** Por que está nesta classificação. */
  reason: string;
  /** Ação de limpeza proposta (null = não há ação segura). */
  proposedAction: StorageActionId | null;
  /** Comando técnico que seria usado (mostrado ao operador). */
  command: string | null;
  /** Detalhe livre (ex.: a tag da imagem, o path). */
  detail: string | null;
  /**
   * Detalhamento de um item com várias parcelas (o cache de build é o caso
   * real: total, compartilhado, privado e o que é REALMENTE liberável).
   */
  breakdown?: StorageBreakdown;
}

/** Detalhamento de espaço de um item. */
export interface StorageBreakdown {
  /** Tamanho TOTAL ocupado. */
  totalBytes: number;
  /** Parcela compartilhada (referenciada por outros artefatos). */
  sharedBytes: number | null;
  /** Parcela privada (exclusiva deste item). */
  privateBytes: number | null;
  /**
   * Bytes que o Docker diz que REALMENTE podem ser liberados agora.
   *
   * É o que o `docker system df` reporta como RECLAIMABLE - não o total do
   * cache. Cache compartilhado/referenciado por imagens e builds atuais não
   * sai com o prune.
   */
  reclaimableBytes: number | null;
  /** De onde veio o número de reclaimable (a fonte de verdade). */
  reclaimableSource: "docker-system-df" | "builder-du" | null;
  /** Aviso de divergência entre `builder du` e `docker system df`. */
  divergenceWarning: string | null;
}

export interface StorageCategorySummary {
  category: StorageCategory;
  bytes: number;
  items: number;
  safeToCleanBytes: number;
  reviewBytes: number;
  keepBytes: number;
  neverTouchBytes: number;
}

export interface StorageOverview {
  /** Categoria "disk" - o todo do disco. */
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  categories: StorageCategorySummary[];
  items: StorageItem[];
  /** Totais por classificação (bytes). */
  safeToCleanBytes: number;
  reviewBytes: number;
  keepBytes: number;
  neverTouchBytes: number;
  /** true quando algum item NEVER_TOUCH foi identificado (proteção ativa). */
  protectionsApplied: boolean;
  /** Observação: a auditoria é read-only e roda no host do Core. */
  note: string;
}

/** Resultado de uma limpeza efetiva. */
export interface StorageCleanupResult {
  action: StorageActionId;
  executedAt: string;
  /** Bytes libertados (0 quando não deu para medir). */
  bytesFreed: number;
  /** O que foi executado (mensagem do comando). */
  output: string | null;
  /** Erro, se houve. */
  error: string | null;
  /** true quando a ação rodou de verdade. */
  executed: boolean;
}

/** Entrada do log de limpeza (nunca contém segredo). */
export interface StorageCleanupLogEntry {
  at: string;
  /** Quem pediu (usuário logado). */
  operator: string;
  action: StorageActionId | null;
  /** Ação pedida (pode não ter sido executada). */
  requested: string[];
  items: number;
  /**
   * Espaço LIVRE do MESMO filesystem (/) antes e depois, em bytes.
   *
   * A mesma fonte (df) e o mesmo filesystem nos dois pontos: é o que torna
   * "livre antes" e "livre depois" comparáveis. Sem isso, o painel mostrava
   * "livre antes" (df) ao lado de "usado depois" (df) - números que não
   * tinham relação nenhuma entre si.
   */
  freeBeforeBytes: number;
  freeAfterBytes: number;
  /** Espaço medido (freeAfter - freeBefore), na mesma base. */
  bytesFreed: number;
  /** Soma do que as ações reportaram ter removido (null = nenhuma mediu). */
  reportedBytesFreed: number | null;
  /** true quando a medição e o relatório divergem (atividade externa). */
  measurementDiverged: boolean;
  failures: string[];
}
