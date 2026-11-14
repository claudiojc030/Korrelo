/**
 * PLANEJADOR DE LIMPEZA DE IMAGENS (somente decisão, nunca executa nada).
 *
 * Regras de segurança:
 *  - protege por TAG e por ID real (duas tags do mesmo ID são a mesma imagem);
 *  - qualquer informação indisponível/inconsistente vira UNKNOWN (nunca DELETE);
 *  - não classifica imagem como descartável só porque não está em `docker ps`;
 *  - `apply` NÃO é suportado nesta fase.
 */
export type ImageGcMode = "off" | "dry-run";

export type ImageGcDecisionType = "KEEP" | "CANDIDATE" | "UNKNOWN";

export interface ImageGcImage {
  /** repo:tag */
  reference: string;
  /** ID real (sha256:... ou prefixo). */
  id: string;
  createdAt: string | Date;
}

export interface ImageGcContainer {
  name: string;
  /** Referência usada pelo container (tag ou ID). */
  imageReference: string;
  /** ID resolvido via `docker inspect`, quando disponível. */
  imageId?: string | null;
  state?: string | null;
}

export interface ImageGcProjectRefs {
  projectId: string;
  currentImage?: string | null;
  previousImage?: string | null;
  /** Referências do compose estável/rollback/job. */
  composeReferences?: string[];
}

export interface ImageGcInput {
  /** Nome da imagem do projeto (sem tag). */
  imageName: string;
  images: ImageGcImage[];
  containers: ImageGcContainer[];
  projects: ImageGcProjectRefs[];
  /** Candidatas de jobs queued/running. */
  activeJobImages?: string[];
  /** Referências de recuperação/manuais que devem ser preservadas. */
  recoveryReferences?: string[];
  /** Referências cujo `docker inspect` falhou (proteção conservadora). */
  unverifiedReferences?: string[];
  /** Quantas imagens não protegidas manter (política atual = 3). */
  retentionExtra?: number;
  /** Disponibilidade das fontes de verdade. */
  databaseOk: boolean;
  dockerOk: boolean;
  mode: ImageGcMode;
}

export interface ImageGcDecision {
  reference: string;
  id: string | null;
  decision: ImageGcDecisionType;
  reasons: string[];
}

export interface ImageGcPlan {
  mode: ImageGcMode;
  decisions: ImageGcDecision[];
  summary: { keep: number; candidate: number; unknown: number; skipped: boolean };
  notes: string[];
}

const RETENTION_EXTRA = 3;

function normalizeId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^sha256:/i, "").toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function timeOf(value: string | Date): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Classifica as imagens do projeto.
 *
 * `mode=off` devolve plano vazio (skipped). `dry-run` apenas decide.
 */
export function planImageGc(input: ImageGcInput): ImageGcPlan {
  const notes: string[] = [];
  if (input.mode === "off") {
    notes.push("KORRELO_IMAGE_GC_MODE=off: nenhuma avaliação executada.");
    return {
      mode: "off",
      decisions: [],
      summary: { keep: 0, candidate: 0, unknown: 0, skipped: true },
      notes,
    };
  }

  const unused: ImageGcDecision[] = [];
  const projectImages = input.images.filter(
    (image) => image.reference.startsWith(`${input.imageName}:`) || image.reference === input.imageName,
  );

  const unverified = new Set((input.unverifiedReferences ?? []).map((ref) => ref.trim()));

  if (!input.databaseOk) {
    notes.push("Banco indisponível: todas as imagens classificadas como UNKNOWN.");
  }
  if (!input.dockerOk) {
    notes.push("Docker indisponível/inconsistente: todas as imagens classificadas como UNKNOWN.");
  }

  if (!input.databaseOk || !input.dockerOk) {
    for (const image of projectImages) {
      unused.push({
        reference: image.reference,
        id: image.id,
        decision: "UNKNOWN",
        reasons: ["fonte de verdade indisponível (banco ou Docker)"],
      });
    }
    return summarize(input.mode, unused, notes);
  }

  const protectedRefs = new Set<string>();
  const protectedIds = new Set<string>();
  const protect = (reference: string | null | undefined) => {
    const ref = reference?.trim();
    if (ref) protectedRefs.add(ref);
  };

  for (const project of input.projects) {
    protect(project.currentImage);
    protect(project.previousImage);
    for (const ref of project.composeReferences ?? []) protect(ref);
  }
  for (const ref of input.activeJobImages ?? []) protect(ref);
  for (const ref of input.recoveryReferences ?? []) protect(ref);

  for (const container of input.containers) {
    // Container parado TAMBÉM protege: nunca usar só `docker ps` (running).
    protect(container.imageReference);
    const id = normalizeId(container.imageId);
    if (id) protectedIds.add(id);
    if (!container.imageId) {
      // Não foi possível resolver o ID: protege a referência e marca
      // conservadoramente qualquer imagem com o mesmo nome/tag.
      unverified.add(container.imageReference);
    }
  }

  // Resolve o ID real das referências protegidas (produção/rollback/job/compose)
  // para que OUTRA tag apontando para o mesmo ID também fique protegida.
  for (const image of projectImages) {
    if (!protectedRefs.has(image.reference)) continue;
    const id = normalizeId(image.id);
    if (id) protectedIds.add(id);
  }

  const protectedByRefOrId = new Set<string>();
  for (const image of projectImages) {
    const id = normalizeId(image.id);
    const isProtectedRef = protectedRefs.has(image.reference);
    const isProtectedId = id !== null && protectedIds.has(id);
    const isUnverified = unverified.has(image.reference) || (id !== null && [...unverified].some((ref) => normalizeId(ref) === id));
    if (isProtectedRef || isProtectedId) {
      protectedByRefOrId.add(image.reference);
      unused.push({
        reference: image.reference,
        id: image.id,
        decision: "KEEP",
        reasons: [isProtectedRef ? "referência protegida (produção/rollback/container/job/compose)" : "ID protegido"],
      });
      continue;
    }
    if (isUnverified) {
      protectedByRefOrId.add(image.reference);
      unused.push({
        reference: image.reference,
        id: image.id,
        decision: "UNKNOWN",
        reasons: ["identidade não verificável (docker inspect/inspeção do container falhou)"],
      });
    }
  }

  const unprotected = projectImages
    .filter((image) => !protectedByRefOrId.has(image.reference))
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));

  const keepExtra = Math.max(0, input.retentionExtra ?? RETENTION_EXTRA);
  unprotected.forEach((image, index) => {
    if (index < keepExtra) {
      unused.push({
        reference: image.reference,
        id: image.id,
        decision: "KEEP",
        reasons: [`retenção atual: ${keepExtra} imagem(ns) não protegida(s) mais recente(s)`],
      });
    } else {
      unused.push({
        reference: image.reference,
        id: image.id,
        decision: "CANDIDATE",
        reasons: ["sem referência de produção/rollback/container/job/compose e fora da retenção"],
      });
    }
  });

  // Determinismo: ordem por decisão e depois por referência.
  unused.sort((a, b) => {
    const order = { KEEP: 0, UNKNOWN: 1, CANDIDATE: 2 } as const;
    return order[a.decision] - order[b.decision] || a.reference.localeCompare(b.reference);
  });

  return summarize(input.mode, unused, notes);
}

function summarize(
  mode: ImageGcMode,
  decisions: ImageGcDecision[],
  notes: string[],
): ImageGcPlan {
  return {
    mode,
    decisions,
    summary: {
      keep: decisions.filter((decision) => decision.decision === "KEEP").length,
      candidate: decisions.filter((decision) => decision.decision === "CANDIDATE").length,
      unknown: decisions.filter((decision) => decision.decision === "UNKNOWN").length,
      skipped: false,
    },
    notes,
  };
}

/** Normaliza a feature flag. `apply` NÃO existe nesta fase. */
export function normalizeImageGcMode(raw: string | undefined | null): {
  mode: ImageGcMode;
  downgraded: boolean;
} {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off") return { mode: "off", downgraded: false };
  if (value === "apply") return { mode: "dry-run", downgraded: true };
  return { mode: "dry-run", downgraded: false };
}
