export type StagingIsolationLevel = "isolated" | "shared";

export interface StagingIsolationFacts {
  /** O staging conecta no mesmo banco/serviço da produção. */
  sharesDatabase: boolean;
  /** O staging monta o mesmo volume gravável de uploads. */
  sharesUploads: boolean;
  /** O staging usa a mesma rede/default do projeto. */
  sharesNetwork: boolean;
  /** O staging recebe o mesmo env_file base da produção. */
  sharesEnv: boolean;
}

export interface StagingIsolationAssessment {
  level: StagingIsolationLevel;
  isolated: boolean;
  sharedResources: string[];
  writableProductionResources: string[];
  /** Requisito explícito do operador para staging isolado. */
  isolationRequired: boolean;
  /** true quando o pipeline sequencial pode rodar para este projeto. */
  sequentialAllowed: boolean;
  blocker: string | null;
}

/**
 * Classificação REAL do staging atual.
 *
 * O compose do Korrelo monta `app_staging` com o mesmo volume de uploads,
 * a mesma rede e o mesmo env_file do app; quando há banco gerenciado, o
 * staging também fala com o banco de produção (--no-deps impede recriá-lo,
 * não impede a conexão). Portanto o padrão é SHARED, nunca "isolated".
 */
export function assessStagingIsolation(
  facts: StagingIsolationFacts,
  options: { isolationRequired?: boolean } = {},
): StagingIsolationAssessment {
  const sharedResources: string[] = [];
  if (facts.sharesDatabase) sharedResources.push("banco de produção");
  if (facts.sharesUploads) sharedResources.push("volume de uploads");
  if (facts.sharesNetwork) sharedResources.push("rede do projeto");
  if (facts.sharesEnv) sharedResources.push("env_file de produção");

  const writableProductionResources = [
    ...(facts.sharesUploads ? ["volume de uploads (gravável)"] : []),
    ...(facts.sharesDatabase ? ["banco de produção"] : []),
  ];
  const isolated = sharedResources.length === 0;
  const isolationRequired = options.isolationRequired === true;

  let blocker: string | null = null;
  if (!isolated) {
    blocker =
      `staging compartilha ${sharedResources.join(", ")}; ` +
      "não pode ser tratado como isolado";
  }
  if (isolationRequired && !isolated) {
    blocker =
      `isolamento de staging exigido, mas ${sharedResources.join(", ")} são compartilhados`;
  }

  return {
    level: isolated ? "isolated" : "shared",
    isolated,
    sharedResources,
    writableProductionResources,
    isolationRequired,
    sequentialAllowed: !isolationRequired || isolated,
    blocker,
  };
}

/** Requisito explícito; default OFF para não mudar o fluxo existente. */
export function isStagingIsolationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.KORRELO_STAGING_REQUIRE_ISOLATION ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
