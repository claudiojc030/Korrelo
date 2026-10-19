import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { runCommand } from "../../../infrastructure/command-runner";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { MANAGED_DATABASE_REPOSITORY, type ManagedDatabaseRepository } from "../domain/managed-database.repository";
import type { Project } from "../domain/project.entity";

/**
 * Reconciliação de runtime (Wave 2.1) - SOMENTE LEITURA.
 *
 * O QUE ESTE SERVIÇO FAZ:
 * - olha os containers que JÁ estão rodando (app de produção e bancos);
 * - registra no Core o que encontrou: limite de memória, imagem, política
 *   de restart, redes e portas (metadado puro);
 * - detecta divergência entre o que o Core registra e o que o Docker mostra.
 *
 * O QUE ESTE SERVIÇO NÃO FAZ (nunca, em nenhuma hipótese):
 * - não cria, remove, reinicia, recria ou atualiza container;
 * - não altera limite de memória, política de restart, rede, porta ou volume;
 * - não redeploya projeto nenhum;
 * - não derruba nem reinicia produção.
 *
 * Se o Docker estiver indisponível, nada acontece: o startup continua, o
 * projeto fica "pendente de reconciliação" e a política de grandfathering
 * mantém o que o Core já sabia (ou, se não souber, o projeto é tratado
 * como pendente até a próxima tentativa).
 */
export interface RuntimeContainerSnapshot {
  name: string;
  /** Limite de memória do container (MB). null = sem limite. */
  memoryLimitMb: number | null;
  /** Uso atual observado (MB) quando o Docker informa. */
  memoryUsageMb: number | null;
  image: string | null;
  restartPolicy: string | null;
  networks: string[];
  ports: string[];
  observedAt: string;
}

export interface ProjectReconciliation {
  projectId: string;
  projectName: string;
  containerName: string | null;
  status: "reconciled" | "not_running" | "docker_unavailable" | "not_found";
  snapshot: RuntimeContainerSnapshot | null;
  databases: { serviceName: string; containerName: string; memoryLimitMb: number | null }[];
  drift: { detected: boolean; details: string[] };
  grandfathered: boolean;
}

export interface ReconciliationReport {
  projects: ProjectReconciliation[];
  dockerAvailable: boolean;
}

const DOCKER_INSPECT_TIMEOUT_MS = 5_000;

interface DockerInspectResult {
  Name?: string;
  Config?: { Image?: string };
  HostConfig?: { Memory?: number; RestartPolicy?: { Name?: string } };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, unknown>;
  };
  State?: { Status?: string; Running?: boolean };
}

@Injectable()
export class RuntimeReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeReconciliationService.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(MANAGED_DATABASE_REPOSITORY) private readonly managedDatabaseRepository: ManagedDatabaseRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const report = await this.reconcileAll();
      this.logger.log(
        `[runtime] reconciliação concluída: ${report.projects.filter((p) => p.status === "reconciled").length} projeto(s) reconciliado(s), ` +
          `docker ${report.dockerAvailable ? "disponível" : "indisponível"}`,
      );
    } catch (error) {
      // Falha na reconciliação NUNCA impede o Core de subir.
      this.logger.warn(`[runtime] reconciliação falhou (o Core segue normalmente): ${(error as Error).message}`);
    }
  }

  async reconcileAll(): Promise<ReconciliationReport> {
    const projects = await this.projectRepository.findAll();
    const results: ProjectReconciliation[] = [];

    for (const project of projects) {
      if (!project.containerName) continue;
      results.push(await this.reconcileProject(project));
    }

    return {
      projects: results,
      dockerAvailable: results.some((r) => r.status === "reconciled" || r.status === "not_found"),
    };
  }

  async reconcileProject(project: Project): Promise<ProjectReconciliation> {
    const containerName = project.containerName as string;
    const snapshot = await this.inspectContainer(containerName);

    if (snapshot === null) {
      const dockerAvailable = await this.isDockerAvailable();
      return {
        projectId: project.id,
        projectName: project.name,
        containerName,
        status: dockerAvailable ? "not_found" : "docker_unavailable",
        snapshot: null,
        databases: [],
        drift: { detected: false, details: [] },
        grandfathered: project.grandfathered,
      };
    }

    // Bancos do projeto: o compose do Korrelo nomeia os containers assim:
    // <containerName>-<serviceName>-1
    const databases = await this.managedDatabaseRepository.findAllByProjectId(project.id);
    const databaseSnapshots: { serviceName: string; containerName: string; memoryLimitMb: number | null }[] = [];
    for (const db of databases) {
      if (db.type === "custom" || !db.serviceName) continue;
      const dbContainerName = `${containerName}-${db.serviceName}-1`;
      const dbSnapshot = await this.inspectContainer(dbContainerName);
      databaseSnapshots.push({
        serviceName: db.serviceName,
        containerName: dbContainerName,
        memoryLimitMb: dbSnapshot?.memoryLimitMb ?? null,
      });

      // Persiste o limite OBSERVADO do banco (metadado). Um banco que já
      // roda mantém esse limite no próximo deploy.
      if (dbSnapshot && db.memoryLimitMb !== dbSnapshot.memoryLimitMb) {
        await this.managedDatabaseRepository.save(db.withMemoryLimit(dbSnapshot.memoryLimitMb));
      }
    }

    const drift = this.detectDrift(project, snapshot);

    // Só metadado é persistido. O container NÃO é tocado.
    const updated = project.withRuntimeObservation({
      productionMemoryLimitMb: snapshot.memoryLimitMb,
      runtimeSnapshot: JSON.stringify(snapshot),
      grandfathered: true,
      grandfatheredAt: project.grandfatheredAt ?? new Date(),
      runtimeDriftDetected: drift.detected,
      runtimeDriftDetails: drift.details.length > 0 ? JSON.stringify(drift.details) : null,
    });
    await this.projectRepository.save(updated);

    if (drift.detected) {
      this.logger.warn(
        `[runtime] divergência detectada no projeto "${project.name}": ${drift.details.join("; ")} (o container NÃO foi alterado)`,
      );
    }

    return {
      projectId: project.id,
      projectName: project.name,
      containerName,
      status: "reconciled",
      snapshot,
      databases: databaseSnapshots,
      drift,
      grandfathered: true,
    };
  }

  /**
   * Lê um container (somente leitura). Devolve null quando o container não
   * existe ou o Docker não respondeu.
   */
  async inspectContainer(containerName: string): Promise<RuntimeContainerSnapshot | null> {
    let stdout: string;
    try {
      const result = await runCommand(
        "docker",
        ["inspect", "--format", "{{json .}}", containerName],
        { timeoutMs: DOCKER_INSPECT_TIMEOUT_MS },
      );
      if (result.timedOut || result.exitCode !== 0 || !result.stdout.trim()) {
        return null;
      }
      stdout = result.stdout.trim();
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(stdout) as DockerInspectResult;
      const memoryBytes = parsed.HostConfig?.Memory ?? 0;
      const ports = Object.keys(parsed.NetworkSettings?.Ports ?? {});
      return {
        name: containerName,
        memoryLimitMb: memoryBytes > 0 ? Math.round(memoryBytes / 1024 / 1024) : null,
        memoryUsageMb: null,
        image: parsed.Config?.Image ?? null,
        restartPolicy: parsed.HostConfig?.RestartPolicy?.Name ?? null,
        networks: Object.keys(parsed.NetworkSettings?.Networks ?? {}),
        ports,
        observedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Divergência entre o estado do Docker e o que o Core tinha registrado.
   *
   * O DOCKER é a fonte da verdade do runtime atual: quando há divergência,
   * registramos o fato - NUNCA "corrigimos" o container.
   */
  private detectDrift(
    project: Project,
    snapshot: RuntimeContainerSnapshot,
  ): { detected: boolean; details: string[] } {
    const details: string[] = [];

    if (!project.runtimeSnapshot) {
      // Primeira observação: não é divergência, é aadotação.
      return { detected: false, details: [] };
    }

    try {
      const previous = JSON.parse(project.runtimeSnapshot) as RuntimeContainerSnapshot;
      if (previous.memoryLimitMb !== snapshot.memoryLimitMb) {
        details.push(
          `limite de memória: Core ${previous.memoryLimitMb ?? "?"} MB → Docker ${snapshot.memoryLimitMb ?? "?"} MB`,
        );
      }
      if (previous.image && snapshot.image && previous.image !== snapshot.image) {
        details.push(`imagem: Core ${previous.image} → Docker ${snapshot.image}`);
      }
      if (previous.restartPolicy && snapshot.restartPolicy && previous.restartPolicy !== snapshot.restartPolicy) {
        details.push(
          `política de restart: Core ${previous.restartPolicy} → Docker ${snapshot.restartPolicy}`,
        );
      }
      if (previous.networks.join(",") !== snapshot.networks.join(",")) {
        details.push(`redes: Core [${previous.networks.join(", ")}] → Docker [${snapshot.networks.join(", ")}]`);
      }
      if (previous.ports.join(",") !== snapshot.ports.join(",")) {
        details.push(`portas: Core [${previous.ports.join(", ")}] → Docker [${snapshot.ports.join(", ")}]`);
      }
    } catch {
      details.push("snapshot anterior ilegível");
    }

    return { detected: details.length > 0, details };
  }

  private async isDockerAvailable(): Promise<boolean> {
    try {
      const result = await runCommand("docker", ["ps", "--format", "{{.Names}}"], {
        timeoutMs: DOCKER_INSPECT_TIMEOUT_MS,
      });
      return !result.timedOut && result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
