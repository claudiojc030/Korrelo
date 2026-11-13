import { Project } from "../domain/project.entity";
import type { ProductionContainerState } from "../domain/container-orchestrator";
import { ReconcileProjectStateUseCase } from "./reconcile-project-state.use-case";

/**
 * RECONCILIAÇÃO EXPLÍCITA (Etapa 1.1).
 *
 * Um projeto em estado INDETERMINADO só volta a aceitar deploys quando
 * container, imagem e READINESS são comprovados. Nada aqui executa Compose.
 */
class FakeProjectRepository {
  saved: Project[] = [];
  constructor(public project: Project | null) {}
  async findById(): Promise<Project | null> {
    return this.project;
  }
  async save(project: Project): Promise<Project> {
    this.project = project;
    this.saved.push(project);
    return project;
  }
}

class FakeOrchestrator {
  state: ProductionContainerState = { kind: "absent" };
  calls: string[] = [];
  async inspectProductionContainer(containerName: string): Promise<ProductionContainerState> {
    this.calls.push(containerName);
    return this.state;
  }
}

class FakeHealthChecker {
  healthy = true;
  calls: { port: number; timeoutMs: number; options?: unknown }[] = [];
  async waitUntilHealthy(port: number, timeoutMs: number, options?: unknown): Promise<boolean> {
    this.calls.push({ port, timeoutMs, options });
    return this.healthy;
  }
}

function indeterminateProject(): Project {
  return Project.create("Mesatta", "https://github.com/exemplo/mesatta.git")
    .withDeployment("korrelo-mesatta-8452004c", 39999)
    .withImages("korrelo-mesatta-8452004c:commit-af66af14684e", null)
    .withLastDeployStatus("indeterminate");
}

describe("ReconcileProjectStateUseCase", () => {
  function build(project: Project, state: ProductionContainerState, healthy = true) {
    const repo = new FakeProjectRepository(project);
    const orchestrator = new FakeOrchestrator();
    orchestrator.state = state;
    const health = new FakeHealthChecker();
    health.healthy = healthy;
    const useCase = new ReconcileProjectStateUseCase(
      repo as any,
      orchestrator as any,
      health as any,
    );
    return { repo, orchestrator, health, useCase };
  }

  it("recusa reconciliar projeto que NÃO está indeterminado", async () => {
    const project = indeterminateProject().withLastDeployStatus("succeeded");
    const { useCase, repo } = build(project, { kind: "absent" });

    await expect(useCase.execute(project.id)).rejects.toThrow(/não está em estado indeterminado/);
    expect(repo.saved).toHaveLength(0);
  });

  it("identidade não comprovável: mantém bloqueio e não altera nada", async () => {
    const project = indeterminateProject();
    const { useCase, repo } = build(project, {
      kind: "unverified",
      containerId: null,
      reason: "Docker indisponível (simulado)",
    });

    await expect(useCase.execute(project.id)).rejects.toThrow(/Não foi possível comprovar/);
    expect(repo.saved).toHaveLength(0);
    expect(project.lastDeployStatus).toBe("indeterminate");
  });

  it("container ausente: libera bloqueio mantendo o último deploy como falho", async () => {
    const project = indeterminateProject();
    const { useCase } = build(project, { kind: "absent" });

    const result = await useCase.execute(project.id);

    expect(result.lastDeployStatus).toBe("failed");
    expect(result.currentImage).toBe("korrelo-mesatta-8452004c:commit-af66af14684e");
  });

  it("container comprovado + readiness OK: adota a imagem e libera novos deploys", async () => {
    const project = indeterminateProject();
    const state: ProductionContainerState = {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:commit-real123456",
      imageId: "sha256:abc",
      running: true,
    };
    const { useCase, health } = build(project, state);

    const result = await useCase.execute(project.id);

    expect(result.lastDeployStatus).toBe("failed");
    expect(result.currentImage).toBe("korrelo-mesatta-8452004c:commit-real123456");
    expect(result.status).toBe("running");
    expect(health.calls).toHaveLength(1);
  });

  it("readiness reprovado: NÃO libera o estado indeterminado", async () => {
    const project = indeterminateProject();
    const state: ProductionContainerState = {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:commit-real123456",
      imageId: "sha256:abc",
      running: true,
    };
    const { useCase, repo } = build(project, state, false);

    await expect(useCase.execute(project.id)).rejects.toThrow(/readiness/i);
    expect(repo.saved).toHaveLength(0);
    expect(project.lastDeployStatus).toBe("indeterminate");
  });

  it("container parado: mantém estado indeterminado", async () => {
    const project = indeterminateProject();
    const { useCase, repo } = build(project, {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:commit-real123456",
      imageId: "sha256:abc",
      running: false,
    });

    await expect(useCase.execute(project.id)).rejects.toThrow(/não está em execução/);
    expect(repo.saved).toHaveLength(0);
  });

  it("recusa tag 'latest' (não é referência versionada)", async () => {
    const project = indeterminateProject();
    const { useCase, repo } = build(project, {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:latest",
      imageId: "sha256:abc",
      running: true,
    });

    await expect(useCase.execute(project.id)).rejects.toThrow(/não é uma tag versionada/);
    expect(repo.saved).toHaveLength(0);
  });
});
