/**
 * CONFIGURAÇÃO DE STAGING POR PROJETO.
 *
 * Motivo real (Mesatta): a produção usa ~538 MB, mas o container de TESTE
 * recebeu só 281 MB do rateio automático - e o Korrelo abortou o deploy
 * depois de 30s sem resposta, porque o bootstrap do Next numa VPS de 1 vCPU
 * precisa de mais tempo (e o healthcheck Docker do Mesatta já tem
 * `start_period: 90s`).
 *
 * O rateio automático (`KORRELO_MEM_STAGING_SHARE`) é GLOBAL: aumentar ele
 * MUDA todos os projetos, o que não é aceitável. Aqui a configuração é por
 * PROJETO e vale SÓ para o container de teste.
 *
 * INVARIANTES (nenhuma delas pode ser furada):
 * 1. O limite de staging NUNCA é aplicado ao container de PRODUÇÃO.
 * 2. O limite de staging NUNCA altera o limite do BANCO.
 * 3. O limite de staging NUNCA altera outro projeto.
 * 4. O timeout de health do staging NUNCA altera o da produção.
 * 5. Sem override (null), o comportamento é EXATAMENTE o de antes.
 */

/** Menor limite de container possível (mesmo piso do budget de memória). */
export const MIN_STAGING_MEMORY_LIMIT_MB = 128;
/** Timeout mínimo da espera de health do staging (segundos). */
export const MIN_STAGING_HEALTH_TIMEOUT_SECONDS = 10;
/** Timeout máximo da espera de health do staging (segundos). */
export const MAX_STAGING_HEALTH_TIMEOUT_SECONDS = 300;

/**
 * Variável RESERVADA que identifica o container de TESTE.
 *
 * O Korrelo injeta `KORRELO_DEPLOY_ENV=staging` em `app_staging` e em
 * NENHUM outro lugar. A aplicação pode usar isso para desligar workers,
 * cron, pollers e tarefas agendadas no ambiente de teste.
 *
 * É reservada: um projeto que tente definir essa chave nas variáveis de
 * ambiente tem o deploy recusado (não sobrescrevemos valor do projeto em
 * silêncio).
 */
export const STAGING_DEPLOY_ENV_VAR = "KORRELO_DEPLOY_ENV";
export const STAGING_DEPLOY_ENV_VALUE = "staging";

/**
 * Prefixo de variável de ambiente aplicada SÓ no staging.
 *
 * `KORRELO_STAGING_FOO=bar` é removida do ambiente de produção e chega ao
 * container de teste como `FOO=bar`. Serve para overrides por ambiente
 * (ex.: desligar um worker, apontar para um bucket separado) sem que a
 * produção veja o valor.
 */
export const STAGING_ENV_PREFIX = "KORRELO_STAGING_";

/**
 * De onde veio o valor efetivo do staging.
 *
 * - "project-override": o projeto configurou explicitamente.
 * - "automatic": o rateio automático de sempre.
 */
export type StagingLimitSource = "project-override" | "automatic";

export interface StagingMemoryDecision {
  /** Limite que será aplicado no container de TESTE (MB). */
  stagingLimitMb: number;
  /** De onde veio o valor. */
  source: StagingLimitSource;
  /** true quando o override foi usado exatamente como configurado. */
  applied: boolean;
  /** Explicação curta (aparece no dry-run e no log de deploy). */
  note: string | null;
}

export interface StagingHealthTimeoutDecision {
  /** Timeout que será usado na espera de health do staging (segundos). */
  seconds: number;
  source: StagingLimitSource;
  applied: boolean;
  note: string | null;
}

/**
 * Decide o limite de memória do container de TESTE.
 *
 * `automaticLimitMb` é o que o rateio automático calculou (o valor de
 * hoje). `overrideLimitMb` é o que o projeto configurou (null = não
 * configurou).
 *
 * Um override NUNCA pode estourar o limite de PRODUÇÃO: um container de
 * teste maior que o app real não faz sentido e aperta a VPS. Quando isso
 * acontece, o valor automático é mantido e o motivo fica registrado.
 */
export function decideStagingMemoryLimit(params: {
  overrideLimitMb: number | null | undefined;
  automaticLimitMb: number;
  /** Limite de produção efetivo (para nunca ultrapassar). */
  productionLimitMb: number;
}): StagingMemoryDecision {
  const automatic = params.automaticLimitMb;
  const override = params.overrideLimitMb;

  if (override === null || override === undefined) {
    return {
      stagingLimitMb: automatic,
      source: "automatic",
      applied: false,
      note: null,
    };
  }

  if (!Number.isFinite(override) || override < MIN_STAGING_MEMORY_LIMIT_MB) {
    return {
      stagingLimitMb: automatic,
      source: "automatic",
      applied: false,
      note:
        `Limite de staging ignorado (${override} MB é menor que o mínimo de ${MIN_STAGING_MEMORY_LIMIT_MB} MB): ` +
        "o rateio automático foi mantido.",
    };
  }

  if (override > params.productionLimitMb) {
    return {
      stagingLimitMb: automatic,
      source: "automatic",
      applied: false,
      note:
        `Limite de staging ignorado (${override} MB é maior que o limite de produção ` +
        `de ${params.productionLimitMb} MB): o rateio automático foi mantido.`,
    };
  }

  return {
    stagingLimitMb: override,
    source: "project-override",
    applied: true,
    note:
      `Limite de staging definido pelo projeto: ${override} MB ` +
      `(rateio automático seria ${automatic} MB). O limite de produção (${params.productionLimitMb} MB) NÃO foi alterado.`,
  };
}

/**
 * Decide o timeout da espera de health do container de TESTE.
 *
 * `defaultSeconds` é o default existente (o de hoje). O override só vale
 * para o staging.
 */
export function decideStagingHealthTimeout(params: {
  overrideSeconds: number | null | undefined;
  defaultSeconds: number;
}): StagingHealthTimeoutDecision {
  const fallback = params.defaultSeconds;
  const override = params.overrideSeconds;

  if (override === null || override === undefined) {
    return { seconds: fallback, source: "automatic", applied: false, note: null };
  }

  if (
    !Number.isFinite(override) ||
    override < MIN_STAGING_HEALTH_TIMEOUT_SECONDS ||
    override > MAX_STAGING_HEALTH_TIMEOUT_SECONDS
  ) {
    return {
      seconds: fallback,
      source: "automatic",
      applied: false,
      note:
        `Timeout de health do staging ignorado (${override}s fora da faixa ` +
        `${MIN_STAGING_HEALTH_TIMEOUT_SECONDS}-${MAX_STAGING_HEALTH_TIMEOUT_SECONDS}s): o default foi mantido.`,
    };
  }

  return {
    seconds: override,
    source: "project-override",
    applied: true,
    note: `Timeout de health do staging definido pelo projeto: ${override}s (default: ${fallback}s).`,
  };
}
