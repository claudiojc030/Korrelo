import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PROFILE_TTL_MS,
  RESOURCE_PROFILE_SCHEMA_VERSION,
  assessProfileEvidence,
  validateResourceProfile,
  type ProfileEvaluation,
  type ResourceProfile,
} from "../domain/resource-profile";

/**
 * PERSISTÊNCIA E CONSULTA DE PERFIS (Resource Manager V1 — Fase C.3c).
 *
 * - arquivo JSON em `$KORRELO_STATE_DIR/resource-profiles.json` (ou
 *   `~/.korrelo/resource-profiles.json` via `KORRELO_STATE_DIR`);
 * - escrita atômica (tmp + fsync + rename) e modo 0600;
 * - limites de tamanho, quantidade total e quantidade por projeto;
 * - schema validado antes de gravar e ao carregar;
 * - arquivo corrompido/ilegível NÃO derruba o Core: memória começa vazia;
 * - nenhum perfil é criado ou inferido: ausência continua ausência.
 *
 * Não há timer, watcher, endpoint de escrita ou decisão adaptativa aqui.
 */
export const RESOURCE_PROFILE_OPTIONS = Symbol("RESOURCE_PROFILE_OPTIONS");

export interface ResourceProfileServiceOptions {
  filePath?: string;
  maxProfiles?: number;
  maxPerProject?: number;
  maxFileBytes?: number;
  reportsDir?: string | null;
  now?: () => number;
  maxAgeMs?: number;
}

export interface StoredProfileSummary {
  projectId: string;
  measuredAt: string;
  validUntil: string | null;
  environment: "lab" | "production";
  cacheState: string | null;
  commitSha: string;
  imageDigest: string | null;
  confidence: "low" | "medium" | "high";
  status: ProfileEvaluation["status"];
  usable: boolean;
  reasons: string[];
  buildPeakMb: number | null;
  buildMemoryLimitMb: number;
  stagingPeakMb: number | null;
  stagingMemoryLimitMb: number;
  oomKilled: boolean;
  targetMatches: boolean | null;
}

export interface ResourceProfilesPanel {
  projectId: string;
  profiles: StoredProfileSummary[];
  latestMeasurement: StoredProfileSummary | null;
  latestValid: StoredProfileSummary | null;
  message: string | null;
  profilesAvailable: number;
}

const DEFAULT_MAX_PROFILES = 200;
const DEFAULT_MAX_PER_PROJECT = 20;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

interface StoreFile {
  schemaVersion: number;
  profiles: ResourceProfile[];
}

@Injectable()
export class ResourceProfileService implements OnModuleInit {
  private readonly logger = new Logger(ResourceProfileService.name);
  private readonly filePath: string;
  private readonly maxProfiles: number;
  private readonly maxPerProject: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly reportsDir: string | null;
  private profiles: ResourceProfile[] = [];

  constructor(
    @Optional()
    @Inject(RESOURCE_PROFILE_OPTIONS)
    options: ResourceProfileServiceOptions = {},
  ) {
    const stateDir = process.env.KORRELO_STATE_DIR ?? join(homedir(), ".korrelo");
    this.filePath = options.filePath ?? process.env.KORRELO_RESOURCE_PROFILES_FILE ?? join(stateDir, "resource-profiles.json");
    this.maxProfiles = positive(options.maxProfiles, DEFAULT_MAX_PROFILES);
    this.maxPerProject = positive(options.maxPerProject, DEFAULT_MAX_PER_PROJECT);
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.now = options.now ?? (() => Date.now());
    this.maxAgeMs = positive(options.maxAgeMs, DEFAULT_PROFILE_TTL_MS);
    this.reportsDir =
      options.reportsDir === null
        ? null
        : options.reportsDir ?? join(dirname(this.filePath), "lab", "reports");
  }

  onModuleInit(): void {
    this.logger.log(`[resources] perfis de recursos em ${this.filePath}`);
    this.load();
    this.importReports();
  }

  /** Perfis persistidos de UM projeto, mais recentes primeiro. */
  list(projectId: string): StoredProfileSummary[] {
    if (!projectId) return [];
    return this.profiles
      .filter((profile) => profile.fingerprint.projectId === projectId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
      .map((profile) => this.toSummary(profile));
  }

  /** Estado para o painel. Ausência é explícita; nada é inventado. */
  describe(projectId: string): ResourceProfilesPanel {
    const summaries = this.list(projectId);
    const latestValid = summaries.find((summary) => summary.usable) ?? null;
    const message =
      summaries.length === 0
        ? "Perfil de build ainda não medido."
        : latestValid
          ? null
          : "Nenhuma medição válida disponível para este projeto.";
    return {
      projectId,
      profiles: summaries,
      latestMeasurement: summaries[0] ?? null,
      latestValid,
      message,
      profilesAvailable: summaries.length,
    };
  }

  /**
   * Persiste um perfil já medido. Rejeita schema inválido e projeto vazio.
   * Nunca fabrica campos ausentes.
   */
  save(profile: ResourceProfile): { saved: boolean; reason: string | null } {
    const validation = validateResourceProfile(profile);
    if (!validation.valid) {
      return { saved: false, reason: `perfil inválido: ${validation.errors.join("; ")}` };
    }
    if (!profile.fingerprint.projectId.trim()) {
      return { saved: false, reason: "projectId ausente" };
    }

    const previous = this.profiles;
    const identity = this.identityOf(profile);
    const next = previous.filter((entry) => this.identityOf(entry) !== identity);
    next.push(profile);
    this.profiles = this.enforceLimits(next);

    try {
      this.persist();
      return { saved: true, reason: null };
    } catch (error) {
      // Falha de escrita não deixa o painel mostrando um perfil que não existe
      // no disco.
      this.profiles = previous;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[resources] não foi possível persistir perfis: ${message}`);
      return { saved: false, reason: "falha ao persistir" };
    }
  }

  /** Quantidade total carregada (diagnóstico). */
  size(): number {
    return this.profiles.length;
  }

  fileLocation(): string {
    return this.filePath;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const size = statSync(this.filePath).size;
      if (size > this.maxFileBytes) {
        this.logger.warn(
          `[resources] arquivo de perfis excede ${this.maxFileBytes} bytes; ignorado (nada foi apagado)`,
        );
        return;
      }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const entries = this.extractProfiles(raw);
      const valid: ResourceProfile[] = [];
      let rejected = 0;
      for (const entry of entries) {
        if (validateResourceProfile(entry).valid) valid.push(entry);
        else rejected += 1;
      }
      this.profiles = this.enforceLimits(valid);
      this.logger.log(
        `[resources] perfis carregados: ${this.profiles.length} (rejeitados: ${rejected})`,
      );
    } catch {
      this.logger.warn("[resources] arquivo de perfis ilegível; começando vazio");
      this.profiles = [];
    }
  }

  /**
   * Importa relatórios REAIS do laboratório (`$STATE/lab/reports/*.json`).
   *
   * Somente JSON estruturalmente válido entra. Relatório bruto, corrompido ou
   * de formato desconhecido é ignorado. Não cria arquivo se nada foi
   * importado e não roda em timer (apenas no boot).
   */
  private importReports(): void {
    if (!this.reportsDir || !existsSync(this.reportsDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.reportsDir).filter((name) => name.endsWith(".json")).slice(0, 100);
    } catch {
      return;
    }

    let added = 0;
    for (const name of files) {
      try {
        const path = join(this.reportsDir, name);
        if (statSync(path).size > this.maxFileBytes) continue;
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!validateResourceProfile(parsed).valid) continue;
        const profile = parsed as ResourceProfile;
        const identity = this.identityOf(profile);
        if (this.profiles.some((entry) => this.identityOf(entry) === identity)) continue;
        this.profiles.push(profile);
        added += 1;
      } catch {
        /* relatório ilegível é ignorado */
      }
    }
    if (added === 0) return;

    this.profiles = this.enforceLimits(this.profiles);
    try {
      this.persist();
      this.logger.log(`[resources] perfis importados do laboratório: ${added}`);
    } catch (error) {
      this.logger.warn(
        `[resources] perfis importados apenas em memória: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private extractProfiles(raw: unknown): ResourceProfile[] {
    if (Array.isArray(raw)) return raw as ResourceProfile[];
    if (!raw || typeof raw !== "object") return [];
    const store = raw as Partial<StoreFile>;
    if (store.schemaVersion !== RESOURCE_PROFILE_SCHEMA_VERSION) return [];
    return Array.isArray(store.profiles) ? (store.profiles as ResourceProfile[]) : [];
  }

  private enforceLimits(profiles: ResourceProfile[]): ResourceProfile[] {
    const sorted = [...profiles].sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
    const perProject = new Map<string, number>();
    const kept: ResourceProfile[] = [];
    for (const profile of sorted) {
      if (kept.length >= this.maxProfiles) break;
      const projectId = profile.fingerprint.projectId;
      const count = perProject.get(projectId) ?? 0;
      if (count >= this.maxPerProject) continue;
      perProject.set(projectId, count + 1);
      kept.push(profile);
    }
    return kept;
  }

  private identityOf(profile: ResourceProfile): string {
    return `${profile.fingerprint.projectId}|${profile.fingerprint.commitSha}|${profile.fingerprint.imageDigest ?? "no-digest"}|${profile.measuredAt}`;
  }

  private toSummary(profile: ResourceProfile): StoredProfileSummary {
    const evaluation = assessProfileEvidence(profile, {
      now: this.now(),
      maxAgeMs: this.maxAgeMs,
    });
    const lab = (profile as { lab?: { cacheState?: string; targetMatches?: boolean } }).lab;
    return {
      projectId: profile.fingerprint.projectId,
      measuredAt: profile.measuredAt,
      validUntil: profile.validUntil,
      environment: profile.environment,
      cacheState: lab?.cacheState ?? null,
      commitSha: profile.fingerprint.commitSha,
      imageDigest: profile.fingerprint.imageDigest,
      confidence: evaluation.confidence,
      status: evaluation.status,
      usable: evaluation.usable,
      reasons: evaluation.reasons,
      buildPeakMb: profile.build.peakMb,
      buildMemoryLimitMb: profile.build.memoryLimitMb,
      stagingPeakMb: profile.staging.peakMb,
      stagingMemoryLimitMb: profile.staging.memoryLimitMb,
      oomKilled: profile.build.oomKilled || profile.staging.oomKilled,
      targetMatches: lab?.targetMatches ?? null,
    };
  }

  /**
   * Escrita ATÔMICA: arquivo temporário no mesmo diretório + fsync + rename.
   * Um leitor nunca vê JSON pela metade; uma escrita interrompida deixa só o
   * `.tmp`, que é ignorado no próximo load.
   */
  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: StoreFile = {
      schemaVersion: RESOURCE_PROFILE_SCHEMA_VERSION,
      profiles: this.profiles,
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes) {
      throw new Error(`payload excede ${this.maxFileBytes} bytes`);
    }
    const temp = `${this.filePath}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      /* plataforma sem POSIX */
    }
    renameSync(temp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* plataforma sem POSIX */
    }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
