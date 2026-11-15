import { Injectable } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  verifyStagingRunOwnership,
  type ObservedStagingResource,
  type StagingRun,
} from "../domain/staging-run";
import type { StagingComposeDocument } from "../domain/staging-compose";
import type {
  StagingRuntimeAdapter,
  StagingRuntimeCleanupInput,
  StagingRuntimeHealthInput,
  StagingRuntimeStartInput,
} from "../domain/staging-execution";

type Runner = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr?: string }>;

const execFile = promisify(execFileCallback) as unknown as Runner;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const HEALTH_ATTEMPTS = 40;
const HEALTH_INTERVAL_MS = 3_000;

/**
 * Runtime Docker/Compose do staging isolado.
 *
 * Regras:
 * - sempre executa com `-p <composeProject>` exclusivo do StagingRun;
 * - `--no-build` quando o documento não declara build (nunca reconstrói imagem);
 * - health somente leitura por `docker inspect`;
 * - cleanup verifica ownership por label antes de qualquer remoção.
 *
 * Sem flag de execução habilitada este adaptador não é chamado.
 */
@Injectable()
export class DockerComposeStagingRuntime implements StagingRuntimeAdapter {
  constructor(
    private readonly run: Runner = execFile,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly baseDir: string = join(tmpdir(), "korrelo-staging"),
  ) {}

  async start(input: StagingRuntimeStartInput): Promise<void> {
    const project = assertComposeProject(input.composeProject, input.run.composeProject);
    const directory = this.runDirectory(input.run);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "compose.json");
    // JSON é YAML válido; o documento já é determinístico.
    await writeFile(file, JSON.stringify(input.document), "utf8");

    const args = ["compose", "-p", project, "-f", file, "up", "-d", "--remove-orphans"];
    if (!documentHasBuild(input.document)) args.push("--no-build");
    await this.run("docker", args, { timeout: COMMAND_TIMEOUT_MS });
  }

  async health(input: StagingRuntimeHealthInput): Promise<boolean> {
    const project = assertComposeProject(input.run.composeProject, input.run.composeProject);
    const container = await this.appContainer(project);
    if (!container) return false;
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      const { stdout } = await this.run(
        "docker",
        ["inspect", "--format", "{{json .State}}", container],
        { timeout: 20_000 },
      );
      const state = safeState(stdout);
      if (!state) return false;
      if (state.Health && state.Health.Status === "unhealthy") return false;
      if (state.Health && state.Health.Status === "healthy") return true;
      if (!state.Health && state.Running === true) return true;
      if (state.Running === false && !state.Health) return false;
      if (attempt < HEALTH_ATTEMPTS - 1) await this.sleep(HEALTH_INTERVAL_MS);
    }
    return false;
  }

  async cleanup(input: StagingRuntimeCleanupInput): Promise<{ ok: boolean; reason?: string | null }> {
    const project = assertComposeProject(input.run.composeProject, input.run.composeProject);
    const containerIds = await this.containersForProject(project);
    for (const id of containerIds) {
      let labels: Record<string, string>;
      try {
        const { stdout } = await this.run(
          "docker",
          ["inspect", "--format", "{{json .Config.Labels}}", id],
          { timeout: 20_000 },
        );
        labels = safeLabels(stdout);
      } catch {
        return { ok: false, reason: "não foi possível verificar ownership do container" };
      }
      const resource: ObservedStagingResource = {
        kind: "container",
        name: id,
        labels,
        composeProject: project,
      };
      const ownership = verifyStagingRunOwnership(input.run, resource);
      if (!ownership.ok) {
        return { ok: false, reason: "ownership inconsistente; cleanup bloqueado" };
      }
    }

    const directory = this.runDirectory(input.run);
    const file = join(directory, "compose.json");
    try {
      await this.run(
        "docker",
        ["compose", "-p", project, "-f", file, "down", "--volumes", "--remove-orphans"],
        { timeout: COMMAND_TIMEOUT_MS },
      );
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, reason: null };
  }

  private async appContainer(project: string): Promise<string | null> {
    const ids = await this.containersForProject(project);
    if (ids.length === 0) return null;
    for (const id of ids) {
      try {
        const { stdout } = await this.run(
          "docker",
          ["inspect", "--format", "{{json .Config.Labels}}", id],
          { timeout: 20_000 },
        );
        const labels = safeLabels(stdout);
        if (labels["com.docker.compose.service"]?.endsWith("_staging")) return id;
      } catch {
        return null;
      }
    }
    return ids[0];
  }

  private async containersForProject(project: string): Promise<string[]> {
    const { stdout } = await this.run(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{.ID}}",
      ],
      { timeout: 20_000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private runDirectory(run: StagingRun): string {
    return join(this.baseDir, safeSegment(run.runId));
  }
}

function assertComposeProject(value: string, expected: string): string {
  if (!value || value !== expected || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error("compose project inválido para execução isolada");
  }
  return value;
}

function documentHasBuild(document: StagingComposeDocument): boolean {
  return Object.values(document.services).some((service) => Boolean(service.build));
}

function safeSegment(value: string): string {
  const segment = String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) throw new Error("identificador de staging inválido");
  return segment;
}

function safeLabels(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") labels[key] = value;
    }
    return labels;
  } catch {
    return {};
  }
}

function safeState(raw: string): { Running?: boolean; Health?: { Status?: string } } | null {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as { Running?: boolean; Health?: { Status?: string } };
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "falha no runtime Docker do staging";
}
