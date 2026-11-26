export type PostPromotionImageState =
  | { kind: "correct"; imageId: string; waitedMs: number }
  | { kind: "incorrect"; imageId: string; waitedMs: number }
  | { kind: "unavailable"; reason: string; waitedMs: number };

export interface VerifyProductionImageInput {
  /** ID da imagem que foi construída e validada no staging. */
  expectedImageId: string;
  /** Leitura do ID realmente executado pelo container de produção. */
  inspect: () => Promise<string | null>;
  /** Limite total de espera pela estabilização do container. */
  timeoutMs?: number;
  /** Intervalo entre leituras. */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export const DEFAULT_PRODUCTION_IMAGE_TIMEOUT_MS = 15_000;
export const MAX_PRODUCTION_IMAGE_TIMEOUT_MS = 60_000;
export const DEFAULT_PRODUCTION_IMAGE_INTERVAL_MS = 500;

/**
 * Espera LIMITADA pela estabilização do container de produção após o promote
 * e confirma a imagem efetivamente executada (`docker inspect .Image`).
 *
 * Regras:
 *  - container ausente/inspeção indisponível => espera e tenta de novo;
 *  - imagem diferente da esperada => FALHA IMEDIATA (não espera);
 *  - timeout sem conseguir ler => `unavailable` (nunca sucesso);
 *  - exceção de inspeção NUNCA vira sucesso;
 *  - ID correto NÃO é saúde: o healthcheck continua obrigatório depois.
 */
export async function verifyProductionImage(
  input: VerifyProductionImageInput,
): Promise<PostPromotionImageState> {
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const intervalMs = boundedInterval(input.intervalMs);
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let lastReason = "container de produção ainda não apareceu";

  for (;;) {
    try {
      const imageId = await input.inspect();
      if (imageId && imageId === input.expectedImageId) {
        return {
          kind: "correct",
          imageId,
          waitedMs: Math.max(0, now() - startedAt),
        };
      }
      if (imageId) {
        return {
          kind: "incorrect",
          imageId,
          waitedMs: Math.max(0, now() - startedAt),
        };
      }
      lastReason = "container de produção sem imagem legível";
    } catch (error) {
      // Falha de inspeção nunca é evidência de sucesso; segue tentando até o
      // limite e termina como indisponível.
      lastReason = `falha ao inspecionar o container: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const elapsed = Math.max(0, now() - startedAt);
    if (elapsed >= timeoutMs) {
      input.log?.(
        `[promote] imagem da produção não pôde ser confirmada em ${timeoutMs}ms (${lastReason})`,
      );
      return { kind: "unavailable", reason: lastReason, waitedMs: elapsed };
    }
    const remaining = timeoutMs - elapsed;
    await sleep(Math.min(intervalMs, remaining));
    if (now() - startedAt > timeoutMs) {
      input.log?.(
        `[promote] timeout aguardando o container de produção (${lastReason})`,
      );
      return {
        kind: "unavailable",
        reason: lastReason,
        waitedMs: Math.max(0, now() - startedAt),
      };
    }
  }
}

function boundedTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PRODUCTION_IMAGE_TIMEOUT_MS;
  }
  return Math.min(MAX_PRODUCTION_IMAGE_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function boundedInterval(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PRODUCTION_IMAGE_INTERVAL_MS;
  }
  return Math.max(1, Math.floor(value));
}
