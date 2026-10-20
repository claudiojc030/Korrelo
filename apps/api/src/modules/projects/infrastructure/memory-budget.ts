/**
 * Orçamento de memória da VPS.
 *
 * PROBLEMA QUE ESTE MÓDULO RESOLVE (achado DEP-01 da auditoria de
 * 19/10/2026): antes, o app recebia o orçamento INTEIRO de RAM disponível e
 * o banco ainda recebia METADE desse valor por fora. Com 1 projeto numa VPS
 * de 4 GB, os limites planejados somavam ~9,2 GB (app 3.696 + staging 3.696
 * + banco 1.848) - mais que o dobro da RAM física. Durante um deploy, app e
 * staging convivem com o mesmo limite, e o build (que roda FORA de qualquer
 * cgroup) ainda toma o resto.
 *
 * MODELO (uma fonte de verdade, tudo na mesma "piscina"):
 *
 *   RAM total
 *     - reserva do host (SO, ssh, cron, journald)
 *     - reserva do Core (API + web do Korrelo, via PM2)
 *     - reserva do Docker (dockerd/containerd, buildkit)
 *     - margem de segurança
 *   = piscina disponível pra projetos
 *
 *   Cada projeto ATIVO recebe uma fatia da piscina:
 *     fatia = piscina / nº de projetos ativos
 *     e dentro da fatia:
 *       staging = fatia * STAGING_SHARE   (temporário, some no fim)
 *       banco   = fatia * DB_SHARE         (se o projeto tiver banco)
 *       app     = fatia - staging - banco
 *
 *   Como app+banco+staging <= fatia, a soma de todos os projetos (contando
 *   o staging de UM projeto, que é o único que sobe por vez) cabe na
 *   piscina. É essa a invariante que o preflight checa antes de buildar.
 *
 * Todos os valores são configuráveis por variável de ambiente (ver
 * getMemoryBudgetConfig) porque o hardware de cada instalação é diferente.
 */

import { decideStagingMemoryLimit, type StagingLimitSource } from "../domain/staging-config";

export interface MemoryBudgetConfig {
  /** SO + serviços de base (sshd, cron, journald, fail2ban...). */
  hostReserveMb: number;
  /** Korrelo API + web (PM2), incluindo folga pro heap. */
  coreReserveMb: number;
  /** dockerd + containerd + buildkit. */
  dockerReserveMb: number;
  /** Margem de segurança (picos, page cache, kernel). */
  safetyMarginMb: number;
  /** Menor limite de container possível. */
  minContainerMb: number;
  /** Maior limite de container possível (evita "container com quase toda a RAM"). */
  maxContainerMb: number;
  /** Fração da fatia do projeto reservada ao banco. */
  dbShare: number;
  /** Fração da fatia do projeto reservada ao staging. */
  stagingShare: number;
  /** Fração do limite do container que o heap do Node (V8) pode usar. */
  nodeHeapRatio: number;
}

export interface ProjectMemoryPlan {
  /** Limite do container do app (produção). */
  appLimitMb: number;
  /** Limite do container do banco (0 se o projeto não tem banco em container). */
  dbLimitMb: number;
  /** Limite do container de staging (temporário). */
  stagingLimitMb: number;
  /** Soma dos três - é o que o projeto ocupa durante um deploy. */
  totalDuringDeployMb: number;
  /** Fração da piscina que este projeto reservou. */
  projectShareMb: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMemoryBudgetConfig(): MemoryBudgetConfig {
  return {
    hostReserveMb: envInt("KORRELO_MEM_HOST_RESERVE_MB", 512),
    coreReserveMb: envInt("KORRELO_MEM_CORE_RESERVE_MB", 640),
    dockerReserveMb: envInt("KORRELO_MEM_DOCKER_RESERVE_MB", 256),
    safetyMarginMb: envInt("KORRELO_MEM_SAFETY_MARGIN_MB", 256),
    minContainerMb: envInt("KORRELO_MEM_MIN_CONTAINER_MB", 128),
    maxContainerMb: envInt("KORRELO_MEM_MAX_CONTAINER_MB", 1024),
    dbShare: envFloat("KORRELO_MEM_DB_SHARE", 0.35),
    stagingShare: envFloat("KORRELO_MEM_STAGING_SHARE", 0.25),
    nodeHeapRatio: envFloat("KORRELO_NODE_HEAP_RATIO", 0.7),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Piscina de memória disponível para os projetos, depois das reservas.
 */
export function computeAvailablePoolMb(totalMemMb: number, config: MemoryBudgetConfig = getMemoryBudgetConfig()): number {
  const reserved = config.hostReserveMb + config.coreReserveMb + config.dockerReserveMb + config.safetyMarginMb;
  return Math.max(0, totalMemMb - reserved);
}

/* ------------------------------------------------------------------ */
/* Wave 2.1: grandfathering                                             */
/* ------------------------------------------------------------------ */

/**
 * Limite EFETIVO de memória do container de PRODUÇÃO.
 *
 * Regras (inegociáveis):
 * 1. Um projeto que já está rodando NUNCA tem o limite reduzido
 *    automaticamente. O que o Docker mostra hoje é a fonte da verdade.
 * 2. Se o admin escolheu um limite MENOR que o atual, a redução de um
 *    container em execução exige confirmação explícita - até lá, o
 *    observado continua valendo (e a redução fica sinalizada).
 * 3. Subir o limite é permitido (dentro do teto máximo).
 * 4. Projeto NOVO (sem runtime observado) usa a fórmula normalmente.
 */
export interface EffectiveMemoryLimit {
  /** Limite que deve ser usado no compose. */
  effectiveLimitMb: number;
  /** Limite que a F�RMULA NOVA calculates (o que seria usado sem grandfathering). */
  calculatedLimitMb: number;
  /** De onde veio o valor. */
  source: "observed" | "admin" | "calculated";
  /** true quando o projeto foi adotado (runtime atual preservado). */
  grandfathered: boolean;
  /**
   * true quando a configuração pedia um limite MENOR que o atual do
   * container em execução - exige confirmação explícita do admin.
   */
  requiresExplicitConfirmation: boolean;
  /** Explicação curta (aparece no dry-run e no log). */
  note: string | null;
}

export function computeEffectiveProductionLimit(params: {
  /** Limite observado no Docker (container de produção). */
  observedLimitMb: number | null;
  /** Limite fixo escolhido pelo admin nas configurações do projeto. */
  adminLimitMb: number | null;
  /** Limite calculado pela fórmula nova. */
  calculatedLimitMb: number;
  /** true quando o projeto está rodando (produção em pé). */
  isRunning: boolean;
  /** true quando o projeto foi adotado (não passou por deploy ainda). */
  isGrandfathered: boolean;
  /**
   * true quando o admin AUTORIZOU explicitamente a redução do limite de um
   * projeto em execução (checkbox de confirmação nas configurações).
   */
  adminReductionApproved?: boolean;
  config?: MemoryBudgetConfig;
}): EffectiveMemoryLimit {
  const config = params.config ?? getMemoryBudgetConfig();
  const observed = params.observedLimitMb && params.observedLimitMb > 0 ? params.observedLimitMb : null;
  const admin = params.adminLimitMb && params.adminLimitMb > 0 ? params.adminLimitMb : null;

  // Projeto novo (sem runtime observado): a fórmula nova vale desde o
  // começo, com o override do admin por cima.
  if (!observed) {
    const limit = clamp(admin ?? params.calculatedLimitMb, config.minContainerMb, config.maxContainerMb);
    return {
      effectiveLimitMb: limit,
      calculatedLimitMb: params.calculatedLimitMb,
      source: admin ? "admin" : "calculated",
      grandfathered: params.isGrandfathered,
      requiresExplicitConfirmation: false,
      note: null,
    };
  }

  // Projeto em execução: o observado é o piso. A fórmula nova NUNCA reduz.
  const floor = Math.max(observed, params.calculatedLimitMb);
  let effective = Math.max(floor, admin ?? 0);
  let source: EffectiveMemoryLimit["source"] = "observed";
  let requiresExplicitConfirmation = false;
  let note: string | null = null;

  if (admin && admin > floor) {
    // Admin pediu MAIS memória: permitido (dentro do teto).
    effective = clamp(admin, config.minContainerMb, config.maxContainerMb);
    source = "admin";
  } else if (admin && admin < floor && params.isRunning) {
    if (params.adminReductionApproved === true) {
      // O admin AUTORIZOU a redução explicitamente: aí sim pode valer.
      effective = clamp(admin, config.minContainerMb, config.maxContainerMb);
      source = "admin";
      note = `Limite reduzido para ${effective} MB com autorização explícita do administrador.`;
    } else {
      // Admin pediu MENOS memória do que o container tem hoje: em execução,
      // isso precisa de confirmação explícita. Até lá, mantém o atual.
      effective = floor;
      source = "observed";
      requiresExplicitConfirmation = true;
      note = `Reduzir de ${observed} MB para ${admin} MB exige confirmação explícita (o container em execução não pode ter a memória diminuída sozinho).`;
    }
  } else if (params.isGrandfathered) {
    note = `Projeto adotado: limite de produção preservado em ${observed} MB (a fórmula nova daria ${params.calculatedLimitMb} MB).`;
  }

  return {
    effectiveLimitMb: effective,
    calculatedLimitMb: params.calculatedLimitMb,
    source,
    grandfathered: params.isGrandfathered,
    requiresExplicitConfirmation,
    note,
  };
}

/**
 * Orçamento de banco POR PROJETO (total, dividido entre os bancos).
 *
 * O erro antigo: cada banco do projeto recebia o budget TOTAL (num projeto
 * com Postgres + Redis, os dois recebiam 600 MB = 1200 MB no total).
 *
 * Agora o budget é TOTAL e dividido por peso:
 *  - Postgres/Mongo: peso 3 ( Precisam de cache/page cache)
 *  - Redis: peso 1 (cache/fila, usa pouco)
 * Ex.: budget 600 MB → Postgres 450 + Redis 150.
 *
 * Bancos que JÁ rodam (grandfathered) mantêm o limite observado - nunca são
 * reduzidos automaticamente. Se a soma dos observados estourar o budget, a
 * diferença é reportada (overcommit pré-existente) e o deploy é bloqueado
 * pelo preflight, em vez de mexer no que está no ar.
 */
export interface DatabaseBudgetInput {
  type: "postgres" | "redis" | "mongodb";
  /** Limite observado do container deste banco (se já existia). */
  observedLimitMb?: number | null;
}

export interface DatabaseBudgetResult {
  limits: { type: DatabaseBudgetInput["type"]; limitMb: number; preserved: boolean }[];
  /** Soma dos limites. */
  totalMb: number;
  /** true quando a soma dos observados estourou o budget (overcommit antigo). */
  overCommitted: boolean;
}

const DB_WEIGHTS: Record<DatabaseBudgetInput["type"], number> = {
  postgres: 3,
  mongodb: 3,
  redis: 1,
};

export function computeDatabaseBudgets(params: {
  totalBudgetMb: number;
  databases: DatabaseBudgetInput[];
  config?: MemoryBudgetConfig;
}): DatabaseBudgetResult {
  const config = params.config ?? getMemoryBudgetConfig();
  const dbs = params.databases;

  const observedTotal = dbs.reduce(
    (sum, db) => sum + (db.observedLimitMb && db.observedLimitMb > 0 ? db.observedLimitMb : 0),
    0,
  );
  const preserved = dbs.filter((db) => db.observedLimitMb && db.observedLimitMb > 0);
  const pending = dbs.filter((db) => !db.observedLimitMb || db.observedLimitMb <= 0);

  // O que sobrou do budget (pode ser negativo se o observado já estoura).
  const remaining = Math.max(0, params.totalBudgetMb - observedTotal);
  const pendingWeight = pending.reduce((sum, db) => sum + DB_WEIGHTS[db.type], 0);

  const limits: DatabaseBudgetResult["limits"] = [];
  let assigned = 0;

  for (const db of preserved) {
    limits.push({
      type: db.type,
      limitMb: db.observedLimitMb as number,
      preserved: true,
    });
    assigned += db.observedLimitMb as number;
  }

  for (const db of pending) {
    const share =
      pendingWeight > 0
        ? Math.floor((remaining * DB_WEIGHTS[db.type]) / pendingWeight)
        : 0;
    const limit = clamp(share, 0, config.maxContainerMb);
    limits.push({ type: db.type, limitMb: limit, preserved: false });
    assigned += limit;
  }

  return {
    limits,
    totalMb: assigned,
    overCommitted: observedTotal > params.totalBudgetMb,
  };
}

/**
 * Reserva total de PRODUÇÃO (soma dos limites dos containers de app que já
 * rodam). É o que o preflight NÃO pode usar: produção existente tem
 * prioridade máxima.
 */
export function computeProductionReservationMb(entries: { limitMb: number | null }[]): number {
  return entries.reduce((sum, entry) => sum + (entry.limitMb && entry.limitMb > 0 ? entry.limitMb : 0), 0);
}

export interface DeploymentMemoryPlan {
  /** Limite do container de PRODUÇÃO (já respeita o grandfathering). */
  productionLimitMb: number;
  /** Limite do container de staging (temporário). */
  stagingLimitMb: number;
  /** De onde veio o limite de staging ("project-override" | "automatic"). */
  stagingLimitSource: StagingLimitSource;
  /** true quando o override de staging foi usado como configurado. */
  stagingLimitApplied: boolean;
  /** Explicação do override de staging (aparece no dry-run/log). */
  stagingLimitNote: string | null;
  /** Budget TOTAL de banco do projeto. */
  databaseBudgetTotalMb: number;
  /** Limite de cada banco (soma ≤ budget total). */
  databaseLimits: { type: DatabaseBudgetInput["type"]; limitMb: number; preserved: boolean }[];
  /** Detalhes do limite efetivo de produção. */
  effective: EffectiveMemoryLimit;
  /** true quando a redução do limite de produção precisa de confirmação. */
  requiresExplicitConfirmation: boolean;
}

/**
 * Plano de memória de um deploy - FONTE ÚNICA de verdade.
 *
 * Usado tanto pelo deploy (o que vai ser aplicado) quanto pelo dry-run (o
 * que SERIA aplicado). Assim o painel nunca mente: o que o dry-run mostra é
 * exatamente o que o deploy faria.
 */
/**
 * Plano de memória de UM projeto (deploy e dry-run usam o mesmo cálculo).
 */
export function computeProjectDeploymentPlan(params: {
  totalMemMb: number;
  activeProjects: number;
  observedProductionLimitMb: number | null;
  adminLimitMb: number | null;
  isRunning: boolean;
  isGrandfathered: boolean;
  adminReductionApproved?: boolean;
  databases: DatabaseBudgetInput[];
  /**
   * Limite de staging configurado PARA ESTE PROJETO (null = automático).
   * Vale SÓ para o container de teste: produção, banco e os outros
   * projetos não são afetados.
   */
  stagingOverrideLimitMb?: number | null;
  config?: MemoryBudgetConfig;
}): DeploymentMemoryPlan {
  return computeDeploymentMemoryPlan(params);
}

export function computeDeploymentMemoryPlan(params: {
  totalMemMb: number;
  activeProjects: number;
  /** Limite observado do container de produção (Docker). */
  observedProductionLimitMb: number | null;
  /** Limite fixo escolhido pelo admin. */
  adminLimitMb: number | null;
  /** O projeto está rodando? */
  isRunning: boolean;
  /** O projeto foi adotado (sem deploy desde a atualização)? */
  isGrandfathered: boolean;
  /** O admin autorizou explicitamente reduzir o limite em execução? */
  adminReductionApproved?: boolean;
  /** Bancos gerenciados do projeto (com o limite observado, se houver). */
  databases: DatabaseBudgetInput[];
  /**
   * Limite de staging configurado PARA ESTE PROJETO (null = automático).
   * Vale SÓ para o container de teste: produção, banco e os outros
   * projetos não são afetados.
   */
  stagingOverrideLimitMb?: number | null;
  config?: MemoryBudgetConfig;
}): DeploymentMemoryPlan {
  const config = params.config ?? getMemoryBudgetConfig();
  const hasDatabase = params.databases.length > 0;

  const base = computeProjectMemoryPlan({
    totalMemMb: params.totalMemMb,
    activeProjects: params.activeProjects,
    hasDatabase,
    overrideAppLimitMb: null,
    config,
  });

  const effective = computeEffectiveProductionLimit({
    observedLimitMb: params.observedProductionLimitMb,
    adminLimitMb: params.adminLimitMb,
    calculatedLimitMb: base.appLimitMb,
    isRunning: params.isRunning,
    isGrandfathered: params.isGrandfathered,
    adminReductionApproved: params.adminReductionApproved,
    config,
  });

  // O budget de banco é uma fatia da fatia do projeto (nunca o budget do
  // app inteiro) e é TOTAl por projeto, dividido entre os bancos.
  const databaseBudgetTotalMb = base.dbLimitMb;
  const databaseBudget = computeDatabaseBudgets({
    totalBudgetMb: databaseBudgetTotalMb,
    databases: params.databases,
    config,
  });

  // O staging automático: calculado a partir da fatia do projeto (e nunca
  // maior que o app), mas também pode ser limitado pela folga real.
  const automaticStagingLimitMb = Math.min(base.stagingLimitMb, effective.effectiveLimitMb);
  // O override por projeto só pode MUDAR o staging. O limite de produção e
  // o budget de banco acima já foram calculados e NÃO são tocados aqui.
  const stagingDecision = decideStagingMemoryLimit({
    overrideLimitMb: params.stagingOverrideLimitMb ?? null,
    automaticLimitMb: automaticStagingLimitMb,
    productionLimitMb: effective.effectiveLimitMb,
  });

  return {
    productionLimitMb: effective.effectiveLimitMb,
    stagingLimitMb: stagingDecision.stagingLimitMb,
    stagingLimitSource: stagingDecision.source,
    stagingLimitApplied: stagingDecision.applied,
    stagingLimitNote: stagingDecision.note,
    databaseBudgetTotalMb,
    databaseLimits: databaseBudget.limits,
    effective,
    requiresExplicitConfirmation: effective.requiresExplicitConfirmation,
  };
}


/**
 * Plano de memória de UM projeto.
 *
 * @param totalMemMb      RAM total da VPS
 * @param activeProjects  quantos projetos estão rodando (o próprio conta)
 * @param hasDatabase     se o projeto tem banco gerenciado em container
 * @param overrideAppLimitMb  limite fixo escolhido pelo admin (opcional)
 */
export function computeProjectMemoryPlan(params: {
  totalMemMb: number;
  activeProjects: number;
  hasDatabase: boolean;
  overrideAppLimitMb?: number | null;
  config?: MemoryBudgetConfig;
}): ProjectMemoryPlan {
  const config = params.config ?? getMemoryBudgetConfig();
  const pool = computeAvailablePoolMb(params.totalMemMb, config);
  const activeProjects = Math.max(1, params.activeProjects);

  // Nenhum projeto ativo: o pool inteiro fica com este projeto (mas ainda
  // respeita o teto máximo por container).
  const share = Math.floor(pool / activeProjects);

  let appLimit: number;
  let dbLimit = 0;
  let stagingLimit = 0;

  if (params.overrideAppLimitMb && params.overrideAppLimitMb > 0) {
    // O admin pediu um limite fixo: ele manda, mas nunca acima do teto
    // máximo (evita "container com quase toda a RAM").
    appLimit = clamp(params.overrideAppLimitMb, config.minContainerMb, config.maxContainerMb);
    const remaining = Math.max(0, share - appLimit);
    dbLimit = params.hasDatabase ? clamp(Math.round(remaining * config.dbShare), 0, config.maxContainerMb) : 0;
    stagingLimit = clamp(Math.round(remaining * config.stagingShare), 0, config.maxContainerMb);
  } else {
    dbLimit = params.hasDatabase ? clamp(Math.round(share * config.dbShare), 0, config.maxContainerMb) : 0;
    stagingLimit = clamp(Math.round(share * config.stagingShare), 0, config.maxContainerMb);
    appLimit = share - dbLimit - stagingLimit;
  }

  // Se o app consumiu a fatia toda (override alto), o staging e o banco
  // cedem espaço - o app em produção tem prioridade.
  const remaining = share - appLimit;
  if (remaining < dbLimit + stagingLimit) {
    const excess = dbLimit + stagingLimit - remaining;
    const stagingCut = Math.min(stagingLimit, Math.max(0, Math.round(excess * 0.6)));
    stagingLimit -= stagingCut;
    dbLimit = Math.max(0, dbLimit - (excess - stagingCut));
  }

  appLimit = clamp(appLimit, config.minContainerMb, config.maxContainerMb);
  dbLimit = clamp(dbLimit, 0, config.maxContainerMb);
  stagingLimit = clamp(stagingLimit, 0, config.maxContainerMb);

  return {
    appLimitMb: appLimit,
    dbLimitMb: dbLimit,
    stagingLimitMb: stagingLimit,
    totalDuringDeployMb: appLimit + dbLimit + stagingLimit,
    projectShareMb: share,
  };
}

/**
 * Heap do Node (V8) dentro do container.
 *
 * O V8 dimensiona o heap pela RAM que enxerga (a do host, não a do cgroup),
 * então sem um teto ele pode crescer além do mem_limit e morrer com "heap
 * out of memory" antes do Docker ter chance de matar o processo. A folga
 * (1 - nodeHeapRatio) cobre memória nativa, buffers, threads e o runtime.
 */
export function computeNodeHeapMb(containerLimitMb: number, config: MemoryBudgetConfig = getMemoryBudgetConfig()): number {
  const heap = Math.round(containerLimitMb * config.nodeHeapRatio);
  return Math.max(64, Math.min(heap, containerLimitMb));
}
