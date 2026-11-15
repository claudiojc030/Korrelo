import { createHash } from "node:crypto";
import type { StagingPlan } from "./staging-planner";

/**
 * Serialização DETERMINÍSTICA para planHash/composeHash.
 *
 * Não inclui valores de segredo. Chaves de objeto são ordenadas e arrays
 * preservam a ordem semântica do plano.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      output[key] = normalize(entry);
    }
    return output;
  }
  return value;
}

/** Hash do plano sem warnings/estado volátil. */
export function hashStagingPlan(plan: StagingPlan): string {
  const canonical = {
    projectId: plan.projectId,
    runId: plan.runId,
    composeProject: plan.composeProject,
    ttlMinutes: plan.ttlMinutes,
    network: plan.network,
    app: plan.app,
    dependencies: plan.dependencies,
    volumes: plan.volumes,
    env: plan.env,
    resources: plan.resources,
    security: plan.security,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/** Hash determinístico do compose renderizado (nunca do env/segredos). */
export function hashStagingCompose(compose: string): string {
  return createHash("sha256").update(String(compose), "utf-8").digest("hex");
}
