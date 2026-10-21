/**
 * AUDITORIA DE ARMAZENAMENTO (READ-ONLY).
 *
 * Mede o disco do host e classifica CADA item encontrado em:
 * SAFE_TO_CLEAN / REVIEW / KEEP / NEVER_TOUCH.
 *
 * NADA É REMOVIDO AQUI. Este serviço só LÊ (df, du, docker system df,
 * docker images, docker ps, docker volume ls, docker builder du).
 *
 * PROTEÇÕES (aplicadas sempre, antes de classificar):
 * - imagens CURRENT e PREVIOUS (rollback) de cada projeto;
 * - a candidata de um deploy em andamento;
 * - qualquer imagem com container usando;
 * - TODO volume nomeado (banco, uploads) é NEVER_TOUCH;
 * - a rede korrelo-shared;
 * - o backup mais recente do Core;
 * - o job de self-update em andamento.
 *
 * Na dúvida é REVIEW - e NUNCA é SAFE.
 */

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand, type RunCommandResult } from "../../../infrastructure/command-runner";import { PROJECT_REPOSITORY, type ProjectRepository } from "../../projects/domain/project.repository";
import {
  STORAGE_ACTIONS,
  type StorageActionId,
  type StorageCategory,
  type StorageCategorySummary,
  type StorageClassification,
  type StorageItem,
  type StorageOverview,
} from "../domain/storage-audit";

/** Ação de limpeza segura (a allowlist viva do serviço). */
export type StorageActionResolver = (action: StorageActionId) => { command: string; label: string };

/** Como o serviço roda um comando externo (injetável nos testes). */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<RunCommandResult>;

/** Runner padrão: o command-runner real do Core (read-only na auditoria). */
export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  runCommand(command, args, { timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS });

const DEFAULT_TIMEOUT_MS = 15_000;

/** Conversão de tamanho humano ("4.058GB", "0B", "1.2 MB") em bytes. */
export function parseHumanSize(value: string): number {
  const text = String(value ?? "").trim().toLowerCase();
  const match = /^([0-9]*\.?[0-9]+)\s*([kmgtpe]?b)?$/.exec(text);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2] ?? "b";
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
    pb: 1024 ** 5,
  };
  return Math.round(amount * (multipliers[unit] ?? 1));
}

/** Parcelas do cache de build, como o `docker builder du` reporta. */
export interface BuilderDu {
  totalBytes: number | null;
  sharedBytes: number | null;
  privateBytes: number | null;
  /** O que o builder DU chama de "Reclaimable" - NÃO é o que o prune vai tirar. */
  reclaimableBytes: number | null;
  /** true quando o output traz as entradas com Shared/Reclaimable (verbose). */
  hasEntries: boolean;
  /** Quantas entradas marcaram "Reclaimable: true". */
  reclaimableEntries: number;
}

/**
 * Parser do `docker builder du`.
 *
 * Formato resumido:
 *   Shared:      4.058GB
 *   Private:     6.573GB
 *   Reclaimable: 4.009GB
 *   Total:       10.63GB
 *
 * Formato verbose (entradas):
 *   ID      RECLAIMABLE   SIZE   LAST ACCESSED
 *   abc123  true          1.2GB  ...
 *   ...     Shared: true
 *
 * IMPORTANTE: o "Reclaimable" do builder du é o que o builder CONSIDERA
 * recuperável - mas o `docker system df` é quem diz o que está REALMENTE
 * liberável agora (o cache compartilhado com imagens/builds atuais não sai).
 */
export function parseBuilderDu(output: string): BuilderDu {
  const result: BuilderDu = {
    totalBytes: null,
    sharedBytes: null,
    privateBytes: null,
    reclaimableBytes: null,
    hasEntries: false,
    reclaimableEntries: 0,
  };
  if (!output) return result;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Entradas do formato verbose: "Shared: true" / "Reclaimable: true".
    if (/^Shared:\s*(true|false)$/i.test(line)) {
      result.hasEntries = true;
      continue;
    }
    if (/^Reclaimable:\s*(true|false)$/i.test(line)) {
      result.hasEntries = true;
      if (/true/i.test(line)) result.reclaimableEntries += 1;
      continue;
    }

    const match = /^(Shared|Private|Reclaimable|Total):\s*([0-9.]+\s*[KMGTPE]?B)$/i.exec(line);
    if (!match) continue;
    const bytes = parseHumanSize(match[2].replace(/\s+/g, ""));
    const key = match[1].toLowerCase();
    if (key === "shared") result.sharedBytes = bytes;
    else if (key === "private") result.privateBytes = bytes;
    else if (key === "reclaimable") result.reclaimableBytes = bytes;
    else if (key === "total") result.totalBytes = bytes;
  }
  return result;
}

/** O que o `docker system df` diz sobre o cache de build. */
export interface SystemDfBuildCache {
  /** Tamanho total do cache. */
  sizeBytes: number | null;
  /** Bytes REALMENTE liberáveis agora (coluna RECLAIMABLE). */
  reclaimableBytes: number | null;
}

/**
 * Segunda fonte de verdade: `docker system df`.
 *
 * A linha do Build Cache é:
 *   TYPE            TOTAL   ACTIVE   SIZE      RECLAIMABLE
 *   Build Cache     42      0        10.63GB   0B
 *
 * A coluna RECLAIMABLE é o que o Docker afirma que pode ser removido sem
 * afetar imagens/caches existentes - é ela que vale (e NÃO o total, nem o
 * "Reclaimable" do builder du).
 */
export function parseSystemDfBuildCache(output: string): SystemDfBuildCache | null {
  if (!output) return null;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!/^Build\s+Cache\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    // TYPE + TOTAL + ACTIVE + SIZE + RECLAIMABLE
    const size = parts[parts.length - 2];
    const reclaimable = parts[parts.length - 1];
    if (!size || !reclaimable) continue;
    return {
      sizeBytes: parseHumanSize(size.replace(/\s+/g, "")),
      reclaimableBytes: parseHumanSize(reclaimable.replace(/\s+/g, "")),
    };
  }
  return null;
}

/** Tamanho de um diretório/arquivo em bytes (du -sb). */
async function directorySize(
  target: string,
  run: CommandRunner,
): Promise<{ bytes: number; entries: number }> {
  const result = await run("du", ["-sb", target], { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (result.exitCode !== 0 || !result.stdout) return { bytes: 0, entries: 0 };
  const first = result.stdout.trim().split("\n")[0] ?? "";
  const bytes = Number.parseInt(first.split(/\s+/)[0] ?? "0", 10);
  return { bytes: Number.isFinite(bytes) ? bytes : 0, entries: 1 };
}

@Injectable()
export class StorageAuditService {
  private readonly logger = new Logger(StorageAuditService.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    // O runner é opcional (o Nest não injeta funções): sem ele, usa o
    // command-runner real do Core. Nos testes, é injetado um fake.
    @Optional() private readonly runCommand: CommandRunner = defaultCommandRunner,
  ) {}
  private get stateDir(): string {
    return process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
  }

  private get selfUpdateDir(): string {
    return process.env.KORRELO_SELF_UPDATE_DIR ?? path.join(this.stateDir, "self-update");
  }

  private get coreRepoDir(): string {
    return (
      process.env.KORRELO_REPO_DIR ?? path.resolve(process.cwd(), "..", "..")
    );
  }

  /** Auditoria completa (read-only). */
  async audit(): Promise<StorageOverview> {
    const disk = await this.auditDisk();
    const docker = await this.auditDocker();
    const korrelo = await this.auditKorrelo();
    const system = await this.auditSystem();

    const items = [...docker.items, ...korrelo.items, ...system.items];
    const categories = this.summarize(disk, [docker, korrelo, system]);

    return {
      totalBytes: disk.totalBytes,
      usedBytes: disk.usedBytes,
      freeBytes: disk.freeBytes,
      usedPercent: disk.usedPercent,
      categories,
      items,
      safeToCleanBytes: sumClassification(items, "SAFE_TO_CLEAN"),
      reviewBytes: sumClassification(items, "REVIEW"),
      keepBytes: sumClassification(items, "KEEP"),
      neverTouchBytes: sumClassification(items, "NEVER_TOUCH"),
      protectionsApplied: items.some((item) => item.classification === "NEVER_TOUCH"),
      note:
        "Auditoria read-only: nada foi removido. A limpeza só acontece por ação explícita, e só para itens da allowlist.",
    };
  }

  // ---------------------------------------------------------------- disco
  private async auditDisk(): Promise<{
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  }> {
    const result = await this.runCommand("df", ["-k", "/"], { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0 };
    }
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    const parts = lastLine.split(/\s+/);
    const totalKb = Number.parseInt(parts[1] ?? "0", 10);
    const usedKb = Number.parseInt(parts[2] ?? "0", 10);
    const freeKb = Number.parseInt(parts[3] ?? "0", 10);
    const totalBytes = Number.isFinite(totalKb) ? totalKb * 1024 : 0;
    const usedBytes = Number.isFinite(usedKb) ? usedKb * 1024 : 0;
    const freeBytes = Number.isFinite(freeKb) ? freeKb * 1024 : 0;
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    return { totalBytes, usedBytes, freeBytes, usedPercent };
  }

  // ---------------------------------------------------------------- docker
  private async auditDocker(): Promise<{ category: StorageCategory; items: StorageItem[] }> {
    const items: StorageItem[] = [];

    // Imagens CURRENT / PREVIOUS / candidata: protegidas por definição.
    const protectedImages = await this.protectedImageReferences();
    const containers = await this.listContainerImages();

    const imagesResult = await this.runCommand(
      "docker",
      ["images", "-a", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}"],
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (imagesResult.exitCode === 0) {
      for (const line of imagesResult.stdout.trim().split("\n").filter(Boolean)) {
        const [reference, id, size] = line.split("\t");
        if (!reference) continue;
        const bytes = parseHumanSize(size ?? "");
        const isDangling = reference.endsWith(":") || reference === "<none>:<none>";
        const usedByContainer = containers.has(reference);
        const isProtected = protectedImages.has(reference);

        if (isProtected || usedByContainer) {
          items.push({
            id: `docker:image:${id ?? reference}`,
            category: "docker",
            label: `Imagem ${reference}`,
            bytes,
            classification: "NEVER_TOUCH",
            reason: isProtected
              ? "Imagem CURRENT, anterior (rollback) ou candidata de um deploy em andamento."
              : "Existe um container usando esta imagem.",
            proposedAction: null,
            command: null,
            detail: reference,
          });
          continue;
        }

        if (isDangling) {
          items.push({
            id: `docker:image:${id ?? reference}`,
            category: "docker",
            label: `Imagem sem tag ${id?.slice(0, 12) ?? ""}`.trim(),
            bytes,
            classification: "SAFE_TO_CLEAN",
            reason: "Camada órfã, sem tag e sem container usando - regenerável.",
            proposedAction: "docker-dangling-images",
            command: STORAGE_ACTIONS["docker-dangling-images"].command,
            detail: reference,
          });
          continue;
        }

        // Imagem commit-<sha> antiga (sem container, sem proteção).
        if (/commit-[0-9a-f]{7,}/i.test(reference)) {
          items.push({
            id: `docker:image:${id ?? reference}`,
            category: "docker",
            label: `Imagem de deploy antiga ${reference}`,
            bytes,
            classification: "REVIEW",
            reason:
              "Imagem de um commit antigo, sem container e sem ser o rollback. Pode ser removida - mas confirme que não é mais precisa.",
            proposedAction: "docker-old-commit-images",
            command: STORAGE_ACTIONS["docker-old-commit-images"].command,
            detail: reference,
          });
          continue;
        }

        items.push({
          id: `docker:image:${id ?? reference}`,
          category: "docker",
          label: `Imagem ${reference}`,
          bytes,
          classification: "KEEP",
          reason: "Imagem com tag que não é candidata à limpeza automática.",
          proposedAction: null,
          command: null,
          detail: reference,
        });
      }
    }

    // Cache de build (BuildKit).
    //
    // Duas fontes de verdade:
    //  - `docker builder du`   -> total, compartilhado, privado e o
    //                             "Reclaimable" do builder;
    //  - `docker system df`     -> o RECLAIMABLE real (o que pode sair sem
    //                             afetar imagens/builds existentes).
    //
    // O que vale para "seguro para limpar" é o RECLAIMABLE do system df.
    // O total do cache (10 GB) NÃO é espaço recuperável: ele é
    // compartilhado/referenciado por imagens e builds atuais. Classificar o
    // total como SAFE fazia o painel prometer ~11 GB que o prune nunca
    // entregaria.
    const builderResult = await this.runCommand("docker", ["builder", "du"], { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (builderResult.exitCode === 0) {
      const builderDu = parseBuilderDu(builderResult.stdout);
      const systemDf = await this.readSystemDfBuildCache();

      const reclaimableSource = systemDf ? "docker-system-df" : builderDu.reclaimableBytes !== null ? "builder-du" : null;
      const reclaimableBytes = systemDf
        ? systemDf.reclaimableBytes
        : builderDu.reclaimableBytes;
      const totalBytes =
        builderDu.totalBytes ?? systemDf?.sizeBytes ?? 0;

      // Divergência entre as duas fontes: fica VISÍVEL (não escondida).
      let divergenceWarning: string | null = null;
      if (
        systemDf &&
        builderDu.reclaimableBytes !== null &&
        systemDf.reclaimableBytes !== builderDu.reclaimableBytes
      ) {
        divergenceWarning =
          `Parte do cache é compartilhada/referenciada e não pode ser liberada sem afetar caches/imagens existentes ` +
          `(docker builder du diz ${formatBytesForMessage(builderDu.reclaimableBytes)} reclaimable, ` +
          `docker system df diz ${formatBytesForMessage(systemDf.reclaimableBytes)}).`;
      }

      const hasReclaimable = (reclaimableBytes ?? 0) > 0;
      items.push({
        id: "docker:builder-cache",
        category: "docker",
        label: "Cache de build (BuildKit)",
        // O que o item ocupa é o TOTAL; o que é recuperável é o reclaimable.
        bytes: totalBytes,
        // Para o "Seguro para limpar" conta só o que o Docker diz que sai.
        safeBytes: hasReclaimable ? (reclaimableBytes ?? 0) : undefined,
        classification: hasReclaimable ? "SAFE_TO_CLEAN" : "KEEP",
        reason: hasReclaimable
          ? `Cache de camadas de build: ${formatBytesForMessage(reclaimableBytes ?? 0)} realmente liberáveis ` +
            `(de ${formatBytesForMessage(totalBytes)} no total). A limpeza preserva o espaço reservado e não toca em imagens/volumes.`
          : `Cache de build total: ${formatBytesForMessage(totalBytes)}, mas o Docker não reporta nada liberável agora ` +
            `(reclaimable 0B): o cache está sendo reutilizado ou compartilhado por imagens/builds existentes. ` +
            `Removê-lo à força não é necessário.`,
        // A ação só é oferecida quando há BENEFÍCIO REAL.
        proposedAction: hasReclaimable ? "docker-builder-cache" : null,
        command: hasReclaimable ? STORAGE_ACTIONS["docker-builder-cache"].command : null,
        detail: null,
        breakdown: {
          totalBytes,
          sharedBytes: builderDu.sharedBytes,
          privateBytes: builderDu.privateBytes,
          reclaimableBytes,
          reclaimableSource,
          divergenceWarning,
        },
      });
    }

    // Containers parados.
    const psResult = await this.runCommand(
      "docker",
      ["ps", "-a", "--filter", "status=exited", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"],
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (psResult.exitCode === 0) {
      for (const line of psResult.stdout.trim().split("\n").filter(Boolean)) {
        const [id, name, image, status] = line.split("\t");
        items.push({
          id: `docker:container:${id ?? name ?? ""}`,
          category: "docker",
          label: `Container parado ${name ?? id ?? ""}`.trim(),
          bytes: 0,
          classification: "REVIEW",
          reason:
            "Container parado: pode guardar estado que interessa. Só é removido explicitamente (nunca em limpeza automática).",
          proposedAction: null,
          command: null,
          detail: `${image ?? ""} (${status ?? ""})`.trim(),
        });
      }
    }

    // Volumes: NUNCA safe.
    const volumeResult = await this.runCommand(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}"],
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (volumeResult.exitCode === 0) {
      for (const name of volumeResult.stdout.trim().split("\n").filter(Boolean)) {
        items.push({
          id: `docker:volume:${name}`,
          category: "docker",
          label: `Volume ${name}`,
          bytes: 0,
          classification: "NEVER_TOUCH",
          reason:
            "Volume nomeado: pode conter o banco de dados ou uploads de um projeto. Nunca é removido por limpeza automática.",
          proposedAction: null,
          command: null,
          detail: name,
        });
      }
    }

    return { category: "docker", items };
  }

  /** Referências de imagem protegidas (current/previous/candidata). */
  private async protectedImageReferences(): Promise<Set<string>> {
    const protectedRefs = new Set<string>();
    try {
      const all = await this.projects.findAll();
      for (const project of all) {
        if (project.currentImage) protectedRefs.add(project.currentImage);
        if (project.previousImage) protectedRefs.add(project.previousImage);
      }
    } catch (error) {
      this.logger.warn(`[storage] não foi possível listar as imagens protegidas: ${error}`);
    }
    return protectedRefs;
  }

  /** Imagens que têm container usando (running ou parado). */
  private async listContainerImages(): Promise<Set<string>> {
    const used = new Set<string>();
    const result = await this.runCommand(
      "docker",
      ["ps", "-a", "--format", "{{.Image}}"],
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return used;
    for (const image of result.stdout.trim().split("\n").filter(Boolean)) {
      used.add(image.trim());
    }
    return used;
  }

  /**
   * Segunda fonte de verdade: `docker system df` (a coluna RECLAIMABLE da
   * linha "Build Cache").
   *
   * É o Docker dizendo o que pode sair AGORA sem afetar imagens/builds
   * existentes. Se o comando falhar, devolve null (o chamador usa o
   * builder du e registra a fonte).
   */
  private async readSystemDfBuildCache(): Promise<SystemDfBuildCache | null> {
    try {
      const result = await this.runCommand("docker", ["system", "df"], { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (result.exitCode !== 0) return null;
      return parseSystemDfBuildCache(result.stdout);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- korrelo
  private async auditKorrelo(): Promise<{ category: StorageCategory; items: StorageItem[] }> {
    const items: StorageItem[] = [];
    const home = os.homedir();

    // Backups do Core (arquivos .db): o mais recente é preservado.
    const backupsDir = path.join(home, "korrelo-backups");
    const backups = await this.auditBackupFiles(backupsDir, ".db");
    for (const item of backups) items.push(item);

    // Snapshots de artefatos do Core (diretórios por timestamp).
    const artifactDir = path.join(home, "korrelo-artifact-backups");
    const artifacts = await this.auditArtifactSnapshots(artifactDir);
    for (const item of artifacts) items.push(item);

    // Logs/jobs do self-update.
    const selfUpdate = await this.auditSelfUpdateDir();
    for (const item of selfUpdate) items.push(item);

    // Logs do PM2.
    const pm2Logs = path.join(home, ".pm2", "logs");
    const pm2 = await directorySize(pm2Logs, this.runCommand);
    if (pm2.bytes > 0) {
      items.push({
        id: "korrelo:pm2-logs",
        category: "korrelo",
        label: "Logs do PM2 (API e Web)",
        bytes: pm2.bytes,
        classification: "REVIEW",
        reason:
          "Logs do PM2 sem rotação configurada: crescem até o disco encher. Recomenda-se ativar o pm2-logrotate (mantém os últimos arquivos).",
        proposedAction: null,
        command: null,
        detail: pm2Logs,
      });
    }

    // Workspaces de projeto (clone + contexto de build).
    const workspace = await this.auditWorkspaces();
    for (const item of workspace) items.push(item);

    return { category: "korrelo", items };
  }

  /** Backups .db: o mais recente é NEVER_TOUCH, os antigos são REVIEW. */
  private async auditBackupFiles(dir: string, extension: string): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return items;
    }
    const files = names.filter((name) => name.endsWith(extension));
    if (files.length === 0) return items;

    const withTimes = files
      .map((name) => {
        try {
          const stat = fs.statSync(path.join(dir, name));
          return { name, bytes: stat.size, mtime: stat.mtimeMs };
        } catch {
          return { name, bytes: 0, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    const newest = withTimes[0];
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const file of withTimes) {
      const isNewest = file.name === newest.name;
      const isOld = now - file.mtime > retentionMs;
      items.push({
        id: `korrelo:backup:${file.name}`,
        category: "korrelo",
        label: `Backup do Core ${file.name}`,
        bytes: file.bytes,
        classification: isNewest ? "NEVER_TOUCH" : isOld ? "REVIEW" : "KEEP",
        reason: isNewest
          ? "Backup MAIS RECENTE: é o ponto de recuperação do Core. Nunca é removido."
          : isOld
            ? "Backup com mais de 7 dias: a retenção sugerida é de 7 dias."
            : "Backup dentro da janela de retenção (7 dias).",
        proposedAction: isNewest || !isOld ? null : "korrelo-old-backups",
        command:
          isNewest || !isOld ? null : STORAGE_ACTIONS["korrelo-old-backups"].command,
        detail: path.join(dir, file.name),
      });
    }
    return items;
  }

  /** Snapshots de artefatos: diretórios por timestamp. */
  private async auditArtifactSnapshots(dir: string): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return items;
    }
    if (names.length === 0) return items;

    const withTimes = names
      .map((name) => {
        try {
          const stat = fs.statSync(path.join(dir, name));
          return { name, mtime: stat.mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    const newest = withTimes[0];
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const snapshot of withTimes) {
      const size = await directorySize(path.join(dir, snapshot.name), this.runCommand);
      const isNewest = snapshot.name === newest.name;
      const isOld = now - snapshot.mtime > retentionMs;
      items.push({
        id: `korrelo:artifact-snapshot:${snapshot.name}`,
        category: "korrelo",
        label: `Snapshot de artefatos do Core ${snapshot.name}`,
        bytes: size.bytes,
        classification: isNewest ? "KEEP" : isOld ? "REVIEW" : "KEEP",
        reason: isNewest
          ? "Snapshot MAIS RECENTE: é o que permite restaurar o Core sem recompilar. É preservado."
          : isOld
            ? "Snapshot com mais de 7 dias, sem função de recuperação atual."
            : "Snapshot dentro da janela de retenção (7 dias).",
        proposedAction: isNewest || !isOld ? null : "korrelo-old-artifact-backups",
        command:
          isNewest || !isOld ? null : STORAGE_ACTIONS["korrelo-old-artifact-backups"].command,
        detail: path.join(dir, snapshot.name),
      });
    }
    return items;
  }

  /** Logs/jobs do self-update: o atual e o em andamento são protegidos. */
  private async auditSelfUpdateDir(): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    const dir = this.selfUpdateDir;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return items;
    }

    // O job "current" (o ponteiro) é o mais recente - nunca é removido.
    let currentId: string | null = null;
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf-8")) as {
        id?: string;
      };
      currentId = pointer.id ?? null;
    } catch {
      /* sem ponteiro */
    }

    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const name of names) {
      if (name === "current.json") continue;
      const isJobFile = name.endsWith(".json") || name.endsWith(".log") || name.endsWith(".pid");
      if (!isJobFile) continue;
      const isCurrent = currentId !== null && name.startsWith(currentId);
      let bytes = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(path.join(dir, name));
        bytes = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }
      if (isCurrent) {
        items.push({
          id: `korrelo:self-update:${name}`,
          category: "korrelo",
          label: `Registro do self-update ${name}`,
          bytes,
          classification: "NEVER_TOUCH",
          reason: "Job ATUAL do self-update (o ponteiro current.json aponta pra ele).",
          proposedAction: null,
          command: null,
          detail: path.join(dir, name),
        });
        continue;
      }
      if (now - mtime <= retentionMs) {
        items.push({
          id: `korrelo:self-update:${name}`,
          category: "korrelo",
          label: `Registro do self-update ${name}`,
          bytes,
          classification: "KEEP",
          reason: "Dentro da janela de retenção (7 dias).",
          proposedAction: null,
          command: null,
          detail: path.join(dir, name),
        });
        continue;
      }
      // UM ITEM POR ARQUIVO (e nunca o diretório inteiro): a limpeza
      // remove o ARQUIVO antigo, não a pasta - apagar a pasta levaria
      // junto o current.json e o job em andamento.
      items.push({
        id: `korrelo:self-update:${name}`,
        category: "korrelo",
        label: `Registro antigo do self-update ${name}`,
        bytes,
        safeBytes: bytes,
        classification: "SAFE_TO_CLEAN",
        reason:
          "Registro de self-update já concluído, com mais de 7 dias. O job atual e o em andamento são preservados.",
        proposedAction: "self-update-old-logs",
        command: STORAGE_ACTIONS["self-update-old-logs"].command,
        detail: path.join(dir, name),
      });
    }
    return items;
  }

  /** Workspaces de projeto: clone + contexto de build, nunca removidos no deploy. */
  private async auditWorkspaces(): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    const roots = [
      path.join(this.coreRepoDir, "apps", "api", "workspace"),
      path.join(os.homedir(), "korrelo", "workspace"),
    ];
    for (const root of roots) {
      const size = await directorySize(root, this.runCommand);
      if (size.bytes <= 0) continue;
      items.push({
        id: `korrelo:workspace:${root}`,
        category: "korrelo",
        label: "Workspaces de projeto (clone + contexto de build)",
        bytes: size.bytes,
        classification: "REVIEW",
        reason:
          "O Korrelo NÃO remove o workspace depois do deploy (só quando o projeto é deletado). Só workspaces de projetos que não existem mais podem ser removidos.",
        proposedAction: null,
        command: null,
        detail: root,
      });
    }
    return items;
  }

  // ---------------------------------------------------------------- sistema
  private async auditSystem(): Promise<{ category: StorageCategory; items: StorageItem[] }> {
    const items: StorageItem[] = [];
    const home = os.homedir();

    const npmCache = path.join(home, ".npm", "_cacache");
    const npm = await directorySize(npmCache, this.runCommand);
    if (npm.bytes > 0) {
      items.push({
        id: "system:npm-cache",
        category: "system",
        label: "Cache do npm",
        bytes: npm.bytes,
        classification: "SAFE_TO_CLEAN",
        reason: "Cache regenerável: o npm rebaixa o que for necessário no próximo build.",
        proposedAction: "npm-cache",
        command: STORAGE_ACTIONS["npm-cache"].command,
        detail: npmCache,
      });
    }

    const aptCache = "/var/cache/apt";
    const apt = await directorySize(aptCache, this.runCommand);
    if (apt.bytes > 0) {
      items.push({
        id: "system:apt-cache",
        category: "system",
        label: "Cache de pacotes do apt",
        bytes: apt.bytes,
        classification: "SAFE_TO_CLEAN",
        reason: "Só os .deb já baixados. Nenhum pacote instalado é removido.",
        proposedAction: "apt-cache",
        command: STORAGE_ACTIONS["apt-cache"].command,
        detail: aptCache,
      });
    }

    const journal = await this.runCommand("journalctl", ["--disk-usage"], { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (journal.exitCode === 0) {
      const match = /([0-9.]+\s*[KMGT]?B)/i.exec(journal.stdout);
      items.push({
        id: "system:journald",
        category: "system",
        label: "Logs do journald",
        bytes: match ? parseHumanSize(match[1].replace(/\s+/g, "")) : 0,
        classification: "REVIEW",
        reason:
          "Journal do systemd: reduz com vacuum (teto de 200MB). Não toca em nenhum serviço.",
        proposedAction: "journal-old",
        command: STORAGE_ACTIONS["journal-old"].command,
        detail: "/var/log/journal",
      });
    }

    for (const tmp of ["/tmp", "/var/tmp"]) {
      const size = await directorySize(tmp, this.runCommand);
      if (size.bytes <= 0) continue;
      items.push({
        id: `system:temp:${tmp}`,
        category: "system",
        label: `Temporários ${tmp}`,
        bytes: size.bytes,
        classification: "REVIEW",
        reason:
          "Temporários do sistema: podem pertencer a outros programas. Só o que o Korrelo criou é removível, e só com mais de 7 dias.",
        proposedAction: null,
        command: null,
        detail: tmp,
      });
    }

    return { category: "system", items };
  }

  // ---------------------------------------------------------------- resumo
  private summarize(
    disk: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number },
    groups: { category: StorageCategory; items: StorageItem[] }[],
  ): StorageCategorySummary[] {
    const summaries: StorageCategorySummary[] = [];
    for (const group of groups) {
      summaries.push({
        category: group.category,
        bytes: group.items.reduce((sum, item) => sum + item.bytes, 0),
        items: group.items.length,
        safeToCleanBytes: sumClassification(group.items, "SAFE_TO_CLEAN"),
        reviewBytes: sumClassification(group.items, "REVIEW"),
        keepBytes: sumClassification(group.items, "KEEP"),
        neverTouchBytes: sumClassification(group.items, "NEVER_TOUCH"),
      });
    }
    summaries.unshift({
      category: "disk",
      bytes: disk.usedBytes,
      items: 1,
      safeToCleanBytes: 0,
      reviewBytes: 0,
      keepBytes: disk.usedBytes,
      neverTouchBytes: 0,
    });
    return summaries;
  }
}

/** Formata bytes para as mensagens (sem arredondar o valor interno). */
function formatBytesForMessage(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sumClassification(items: StorageItem[], classification: StorageClassification): number {
  return items
    .filter((item) => item.classification === classification)
    .reduce(
      (sum, item) =>
        // Para "SAFE_TO_CLEAN" conta o que é REALMENTE liberável (o cache de
        // build ocupa 10 GB, mas pode liberar só 0 B). Para as demais
        // classificações, conta o espaço ocupado.
        sum + (classification === "SAFE_TO_CLEAN" ? item.safeBytes ?? item.bytes : item.bytes),
      0,
    );
}
