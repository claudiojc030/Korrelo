import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../../../infrastructure/command-runner";
import { DEPLOY_JOB_REPOSITORY, type DeployJobRepository } from "../domain/deploy-job.repository";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import {
  normalizeImageGcMode,
  planImageGc,
  readImageRetentionExtra,
  type ImageGcContainer,
  type ImageGcImage,
  type ImageGcPlan,
  type ImageGcProjectRefs,
} from "../domain/image-gc-planner";
import { getProjectWorkspacePath } from "./workspace-paths";
import { isReconciling } from "./reconciliation-lock";

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

  async audit(options: { readOnly?: boolean } = {}): Promise<ImageGcPlan> {
    const readOnly = options.readOnly === true;
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
      return await this.auditInternal(readOnly);
    } finally {
      this.inFlight = false;
    }
  }

  private async auditInternal(readOnly: boolean): Promise<ImageGcPlan> {
    const normalized = normalizeImageGcMode(process.env.KORRELO_IMAGE_GC_MODE);
    const mode = readOnly ? "dry-run" : normalized.mode;
    const downgraded = readOnly && normalized.mode === "apply";
    if (downgraded) {
      this.logger.warn(
        "KORRELO_IMAGE_GC_MODE=apply ignorado nesta auditoria: endpoint administrativo é somente leitura.",
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
    let inventoryTruncated = false;
    let inspectFailures = 0;
    for (const line of (psResult.stdout ?? "").split("\n").filter(Boolean)) {
      const [name, imageReference, state] = line.split("\t");
      if (!name || !imageReference) continue;
      const overBudget = inspected >= maxContainers || Date.now() - startedAt > budgetMs;
      if (overBudget) {
        // Inventário TRUNCADO: não é seguro decidir nada nesta execução.
        inventoryTruncated = true;
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
        inspectFailures += 1;
        unverifiedReferences.push(imageReference);
      }
      containers.push({ name, imageReference, imageId, state: state ?? null });
    }

    let databaseOk = true;
    let projectRefs: ImageGcProjectRefs[] = [];
    let activeJobImages: string[] = [];
    const unknownImageNames: string[] = [];
    const composeErrors: string[] = [];
    try {
      const all = await this.projects.findAll();
      const scans = await Promise.all(all.map((project) => this.readComposeReferences(project.id, Boolean(project.currentImage))));
      projectRefs = all.map((project, index) => {
        const scan = scans[index];
        if (scan.error) {
          composeErrors.push(`${project.id}: ${scan.error}`);
          if (project.containerName?.startsWith("korrelo-")) {
            unknownImageNames.push(project.containerName);
          }
        }
        if (!project.currentImage && project.containerName?.startsWith("korrelo-")) {
          // Sem identidade de produção comprovada: NUNCA candidata.
          unknownImageNames.push(project.containerName);
        }
        return {
          projectId: project.id,
          containerName: project.containerName,
          currentImage: project.currentImage,
          previousImage: project.previousImage,
          composeReferences: scan.references,
        };
      });
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

    const managedNames = projectImageNames(projectRefs, containers, activeJobImages);
    const merged = planImageGc({
      imageName: managedNames[0] ?? "",
      imageNames: managedNames.slice(1),
      images,
      containers,
      projects: projectRefs,
      activeJobImages,
      unverifiedReferences,
      unknownImageNames,
      inventoryComplete: !inventoryTruncated && inspectFailures === 0,
      retentionExtra: readImageRetentionExtra(),
      databaseOk,
      dockerOk,
      mode,
    });
    this.logPlan(merged);
    if (mode === "apply" && !merged.summary.skipped) {
      await this.applyCandidates(merged, managedNames, unverifiedReferences, unknownImageNames, composeErrors);
    }
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

  /**
   * APLICAÇÃO (apply) — somente `docker image rm <tag>`, sem `-f`, nunca por
   * ID. Revalida banco, fila, containers, compose e identidade imediatamente
   * antes de cada remoção. Qualquer dúvida = skip.
   */
  private async applyCandidates(
    plan: ImageGcPlan,
    managedNames: string[],
    unverifiedReferences: string[],
    unknownImageNames: string[],
    composeErrors: string[],
  ): Promise<void> {
    const applied = { removed: [] as string[], skipped: [] as string[] };
    const skipAll = (reason: string) => {
      for (const decision of plan.decisions) {
        if (decision.decision === "CANDIDATE") {
          applied.skipped.push(decision.reference);
          this.logger.warn(
            `[image-gc][apply] ref=${decision.reference} id=${decision.id ?? "?"} result=skipped reason=${reason}`,
          );
        }
      }
      plan.applied = applied;
    };

    try {
      if (composeErrors.length > 0) {
        skipAll("referências de Compose não puderam ser verificadas");
        return;
      }
      if (isReconciling()) {
        skipAll("reconciliação de projeto em andamento");
        return;
      }
      const lockPath = path.join(os.homedir(), ".korrelo", "self-update.lock");
      try {
        await fs.access(lockPath);
        skipAll("self-update em andamento");
        return;
      } catch {
        // Sem lock de self-update.
      }

      const [queued, running] = await Promise.all([
        this.jobs.findAllByStatus("queued"),
        this.jobs.findAllByStatus("running"),
      ]);
      if (queued.length > 0 || running.length > 0) {
        skipAll("deploy na fila ou em execução");
        return;
      }

      const projects = await this.projects.findAll();
      const protectedRefs = new Set<string>();
      const protectedIds = new Set<string>();
      const unknownNamesFresh = new Set(unknownImageNames);
      for (const project of projects) {
        if (project.currentImage) protectedRefs.add(project.currentImage);
        if (project.previousImage) protectedRefs.add(project.previousImage);
        if (!project.currentImage && project.containerName?.startsWith("korrelo-")) {
          unknownNamesFresh.add(project.containerName);
        }
        const scan = await this.readComposeReferences(project.id, Boolean(project.currentImage));
        if (scan.error) {
          skipAll(`Compose de ${project.id} ilegível: ${scan.error}`);
          return;
        }
        for (const ref of scan.references) protectedRefs.add(ref);
      }

      const ps = await this.readDocker(["ps", "-a", "--format", "{{.Names}}\t{{.Image}}"]);
      if (ps.exitCode !== 0) {
        skipAll("não foi possível listar containers");
        return;
      }
      for (const line of ps.stdout.split("\n").filter(Boolean)) {
        const [, reference] = line.split("\t");
        if (!reference) {
          skipAll("container sem referência de imagem");
          return;
        }
        protectedRefs.add(reference);
        const inspect = await this.readDocker([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          reference,
        ]);
        if (inspect.exitCode !== 0 || !inspect.stdout.trim()) {
          skipAll(`identidade do container ${reference} não verificável`);
          return;
        }
        protectedIds.add(normalizeImageId(inspect.stdout));
      }

      const spaceBefore = await this.readSpaceSummary();
      const managed = new Set(managedNames);
      const unverified = new Set(unverifiedReferences);

      for (const decision of plan.decisions) {
        if (decision.decision !== "CANDIDATE") continue;
        const separator = decision.reference.lastIndexOf(":");
        const imageName = separator > 0 ? decision.reference.slice(0, separator) : "";
        const skip = (reason: string) => {
          applied.skipped.push(decision.reference);
          this.logger.warn(
            `[image-gc][apply] ref=${decision.reference} id=${decision.id ?? "?"} result=skipped reason=${reason}`,
          );
        };
        if (!managed.has(imageName)) {
          skip("imagem fora dos nomes gerenciados");
          continue;
        }
        if (unknownNamesFresh.has(imageName)) {
          skip("projeto sem identidade confiável (currentImage nulo)");
          continue;
        }
        if (unverified.has(decision.reference)) {
          skip("referência não verificável");
          continue;
        }
        if (protectedRefs.has(decision.reference)) {
          skip("referência protegida (produção/rollback/container/compose)");
          continue;
        }
        const inspect = await this.readDocker([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          decision.reference,
        ]);
        const currentId = inspect.exitCode === 0 ? normalizeImageId(inspect.stdout) : "";
        if (!currentId) {
          skip("imagem ausente ou identidade não verificável");
          continue;
        }
        if (decision.id && normalizeImageId(decision.id) !== currentId) {
          skip("identidade mudou entre planejamento e remoção");
          continue;
        }
        if (protectedIds.has(currentId)) {
          skip("ID protegido por container");
          continue;
        }
        try {
          const rm = await this.readDocker(["image", "rm", decision.reference]);
          if (rm.exitCode === 0) {
            applied.removed.push(decision.reference);
            this.logger.log(
              `[image-gc][apply] ref=${decision.reference} id=${currentId} result=removed reason=sem referência protegida`,
            );
          } else {
            skip(`docker image rm falhou: ${(rm.stderr || "").trim().slice(0, 200)}`);
          }
        } catch (error) {
          skip(`docker image rm falhou: ${(error as Error).message}`);
        }
      }

      const spaceAfter = await this.readSpaceSummary();
      this.logger.log(
        `[image-gc][apply] summary removed=${applied.removed.length} skipped=${applied.skipped.length} ` +
          `space_before="${spaceBefore}" space_after="${spaceAfter}"`,
      );
      plan.applied = applied;
    } catch (error) {
      skipAll(`falha de revalidação: ${(error as Error).message}`);
    }
  }

  private async readSpaceSummary(): Promise<string> {
    const result = await this.readDocker(["system", "df", "--format", "{{.Type}}={{.Size}}"]);
    if (result.exitCode !== 0) return "indisponível";
    return result.stdout.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  private async readComposeReferences(
    projectId: string,
    _hasKnownImage = false,
  ): Promise<{ references: string[]; error: string | null }> {
    const dir = getProjectWorkspacePath(projectId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Workspace ausente = nenhum Compose conhecido (legítimo). Falha de
      // leitura (permissão, I/O) é erro e bloqueia decisões.
      if (code === "ENOENT") return { references: [], error: null };
      return { references: [], error: `readdir falhou (${code ?? (error as Error).message})` };
    }
    const references: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("docker-compose.korrelo") || !entry.endsWith(".yml")) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(dir, entry), "utf-8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // arquivo legitimamente ausente
        return { references: [], error: `leitura de ${entry} falhou (${code ?? (error as Error).message})` };
      }
      if (content.trim().length === 0 || !/^\s*services:\s*$/m.test(content)) {
        return { references: [], error: `${entry} malformado (sem bloco services)` };
      }
      for (const line of content.split("\n")) {
        const match = /^\s*image:\s*([^\s#]+)/.exec(line);
        const reference = match?.[1];
        // Referências interpoladas (${...}) não são tags concretas.
        if (reference && !reference.includes("${")) references.push(reference);
      }
    }
    return { references, error: null };
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

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeImageId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^sha256:/i, "").toLowerCase();
}

function projectImageNames(
  projects: ImageGcProjectRefs[],
  containers: ImageGcContainer[] = [],
  activeJobImages: string[] = [],
): string[] {
  const names = new Set<string>();
  const managedContainerNames = new Set(
    projects.map((project) => project.containerName).filter((name): name is string => Boolean(name)),
  );
  const add = (ref: string | null | undefined) => {
    if (!ref) return;
    const index = ref.lastIndexOf(":");
    if (index > 0) {
      const name = ref.slice(0, index);
      // Só nomes gerenciados pelo Korrelo. Imagens externas (mongo, postgres,
      // redis, app:latest) NUNCA entram na avaliação.
      if (name.startsWith("korrelo-")) names.add(name);
    }
  };
  for (const project of projects) {
    if (project.containerName?.startsWith("korrelo-")) names.add(project.containerName);
    add(project.currentImage);
    add(project.previousImage);
    for (const ref of project.composeReferences ?? []) add(ref);
  }
  for (const ref of activeJobImages) add(ref);
  for (const container of containers) {
    if (managedContainerNames.has(container.name) || container.imageReference.startsWith("korrelo-")) {
      add(container.imageReference);
    }
  }
  return [...names].filter(Boolean);
}
