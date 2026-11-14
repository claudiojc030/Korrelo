import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runCommand } from "../../../infrastructure/command-runner";
import { DEPLOY_JOB_REPOSITORY, type DeployJobRepository } from "../domain/deploy-job.repository";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  normalizeImageGcMode,
  planImageGc,
  type ImageGcContainer,
  type ImageGcImage,
  type ImageGcPlan,
  type ImageGcProjectRefs,
} from "../domain/image-gc-planner";
import { getProjectWorkspacePath } from "./workspace-paths";

export type DockerReadRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{
  exitCode: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}>;

interface ServiceLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * COLETA READ-ONLY + PLANO DRY-RUN.
 *
 * Só executa comandos de leitura (`docker images`, `docker ps -a`,
 * `docker inspect`) e leituras do SQLite/workspace. NUNCA chama `rmi`,
 * `prune`, `stop`, `rm` ou `compose`.
 */
@Injectable()
export class ImageGcAuditService {
  private readonly logger: ServiceLogger = new Logger(ImageGcAuditService.name);
  private readonly runner: DockerReadRunner;
  private inFlight = false;

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(DEPLOY_JOB_REPOSITORY) private readonly jobs: DeployJobRepository,
    @Optional() runner?: DockerReadRunner,
  ) {
    this.runner = runner ?? ((command, args, options) =>
      runCommand(command, args, { timeoutMs: options?.timeoutMs ?? 20_000 }));
  }

  async audit(): Promise<ImageGcPlan> {
    if (this.inFlight) {
      return {
        mode: "dry-run",
        decisions: [],
        summary: { keep: 0, candidate: 0, unknown: 0, skipped: true },
        notes: ["auditoria já em andamento: resultado descartado para não misturar estados"],
      };
    }
    this.inFlight = true;
    try {
      return await this.auditInternal();
    } finally {
      this.inFlight = false;
    }
  }

  private async auditInternal(): Promise<ImageGcPlan> {
    const { mode, downgraded } = normalizeImageGcMode(process.env.KORRELO_IMAGE_GC_MODE);
    if (downgraded) {
      this.logger.warn(
        "KORRELO_IMAGE_GC_MODE=apply não é suportado nesta fase; rodando em dry-run.",
      );
    }
    if (mode === "off") {
      return planImageGc({
        imageName: "",
        images: [],
        containers: [],
        projects: [],
        databaseOk: true,
        dockerOk: true,
        mode: "off",
      });
    }

    const imagesResult = await this.readDocker([
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}",
    ]);
    const psResult = await this.readDocker([
      "ps",
      "-a",
      "--format",
      "{{.Names}}\t{{.Image}}\t{{.State}}",
    ]);

    const images: ImageGcImage[] = (imagesResult.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [reference, id, createdAt] = line.split("\t");
        return { reference: reference ?? "", id: id ?? "", createdAt: createdAt ?? "" };
      })
      .filter((image) => image.reference && !image.reference.includes("<none>"));

    const containers: ImageGcContainer[] = [];
    const unverifiedReferences: string[] = [];
    const maxContainers = envPositiveInt("KORRELO_IMAGE_GC_MAX_CONTAINERS", 50);
    const budgetMs = envPositiveInt("KORRELO_IMAGE_GC_TIMEOUT_MS", 15_000);
    const startedAt = Date.now();
    let inspected = 0;
    for (const line of (psResult.stdout ?? "").split("\n").filter(Boolean)) {
      const [name, imageReference, state] = line.split("\t");
      if (!name || !imageReference) continue;
      const overBudget = inspected >= maxContainers || Date.now() - startedAt > budgetMs;
      if (overBudget) {
        // Conservador: não afirma nada sobre o ID; a referência fica UNKNOWN.
        unverifiedReferences.push(imageReference);
        containers.push({ name, imageReference, imageId: null, state: state ?? null });
        continue;
      }
      inspected += 1;
      const inspect = await this.readDocker(["inspect", "-f", "{{.Image}}", name]);
      let imageId: string | null = null;
      if (inspect.exitCode === 0 && inspect.stdout.trim()) {
        imageId = inspect.stdout.trim();
      } else {
        unverifiedReferences.push(imageReference);
      }
      containers.push({ name, imageReference, imageId, state: state ?? null });
    }

    let databaseOk = true;
    let projectRefs: ImageGcProjectRefs[] = [];
    let activeJobImages: string[] = [];
    try {
      const all = await this.projects.findAll();
      projectRefs = await Promise.all(
        all.map(async (project) => ({
          projectId: project.id,
          currentImage: project.currentImage,
          previousImage: project.previousImage,
          composeReferences: await this.readComposeReferences(project.id),
        })),
      );
      const [queued, running] = await Promise.all([
        this.jobs.findAllByStatus("queued"),
        this.jobs.findAllByStatus("running"),
      ]);
      activeJobImages = [...queued, ...running]
        .map((job) => job.candidateImage)
        .filter((image): image is string => typeof image === "string" && image.length > 0);
    } catch (error) {
      databaseOk = false;
      this.logger.warn(`[image-gc] banco indisponível: ${(error as Error).message}`);
    }

    const dockerOk = imagesResult.exitCode === 0 && psResult.exitCode === 0;
    if (!dockerOk) {
      this.logger.warn(
        `[image-gc] Docker indisponível para coleta (images=${imagesResult.exitCode}, ps=${psResult.exitCode})`,
      );
    }

    const perImage = await Promise.all(
      projectImageNames(projectRefs, containers).map((imageName) =>
        Promise.resolve(
          planImageGc({
            imageName,
            images,
            containers,
            projects: projectRefs,
            activeJobImages,
            unverifiedReferences,
            retentionExtra: readRetentionExtra(),
            databaseOk,
            dockerOk,
            mode,
          }),
        ),
      ),
    );

    const merged: ImageGcPlan = {
      mode,
      decisions: perImage.flatMap((plan) => plan.decisions),
      summary: perImage.reduce<{
        keep: number;
        candidate: number;
        unknown: number;
        skipped: boolean;
      }>(
        (acc, plan) => ({
          keep: acc.keep + plan.summary.keep,
          candidate: acc.candidate + plan.summary.candidate,
          unknown: acc.unknown + plan.summary.unknown,
          skipped: acc.skipped && plan.summary.skipped,
        }),
        { keep: 0, candidate: 0, unknown: 0, skipped: true },
      ),
      notes: perImage.flatMap((plan) => plan.notes),
    };

    if (merged.summary.skipped) {
      merged.summary.skipped = false;
    }
    this.logPlan(merged);
    return merged;
  }

  private async readDocker(args: string[]): Promise<{
    exitCode: number | null;
    timedOut?: boolean;
    stdout: string;
    stderr: string;
  }> {
    try {
      return await this.runner("docker", args, { timeoutMs: 20_000 });
    } catch (error) {
      return {
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readComposeReferences(projectId: string): Promise<string[]> {
    const dir = getProjectWorkspacePath(projectId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const references: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("docker-compose.korrelo") || !entry.endsWith(".yml")) continue;
      try {
        const content = await fs.readFile(path.join(dir, entry), "utf-8");
        for (const line of content.split("\n")) {
          const match = /^\s*image:\s*([^\s#]+)/.exec(line);
          const reference = match?.[1];
          // Referências interpoladas (${...}) não são tags concretas.
          if (reference && !reference.includes("${")) references.push(reference);
        }
      } catch {
        // Arquivo ilegível: o planejador tratará as imagens do projeto como
        // UNKNOWN apenas se não houver outra proteção; não afirmamos DELETE.
      }
    }
    return references;
  }

  private logPlan(plan: ImageGcPlan): void {
    const maxLines = envPositiveInt("KORRELO_IMAGE_GC_MAX_LOG_LINES", 100);
    let logged = 0;
    for (const decision of plan.decisions) {
      if (logged >= maxLines) break;
      logged += 1;
      this.logger.log(
        `[image-gc] mode=${plan.mode} ref=${decision.reference} id=${decision.id ?? "?"} ` +
          `decision=${decision.decision} reason=${decision.reasons.join("; ")}`,
      );
    }
    if (plan.decisions.length > logged) {
      this.logger.warn(
        `[image-gc] log truncado: ${plan.decisions.length - logged} decisão(ões) não registradas ` +
          `(limite ${maxLines})`,
      );
    }
    this.logger.log(
      `[image-gc] summary mode=${plan.mode} keep=${plan.summary.keep} ` +
        `candidate=${plan.summary.candidate} unknown=${plan.summary.unknown} (nenhuma remoção executada)`,
    );
  }
}

function readRetentionExtra(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.KORRELO_IMAGE_GC_RETENTION_EXTRA ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function projectImageNames(projects: ImageGcProjectRefs[], containers: ImageGcContainer[] = []): string[] {
  const names = new Set<string>();
  const add = (ref: string | null | undefined) => {
    if (!ref) return;
    const index = ref.lastIndexOf(":");
    if (index > 0) names.add(ref.slice(0, index));
  };
  for (const project of projects) {
    add(project.currentImage);
    add(project.previousImage);
    for (const ref of project.composeReferences ?? []) add(ref);
  }
  for (const container of containers) add(container.imageReference);
  return [...names].filter(Boolean);
}
