import { Project } from "../domain/project.entity";
import type { ProductionContainerState } from "../domain/container-orchestrator";
import { ReconcileProjectStateUseCase } from "./reconcile-project-state.use-case";

/**
 * RECONCILIAÇÃO EXPLÍCITA (Etapa 1.1).
 *
 * Um projeto em estado INDETERMINADO só volta a aceitar deploys quando o
 * container real comprova a imagem. Nada aqui executa Compose, reinicia
 * container ou publica arquivos.
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

function indeterminateProject(): Project {
  return Project.create("Mesatta", "https://github.com/exemplo/mesatta.git")
    .withDeployment("korrelo-mesatta-8452004c", 39999)
    .withImages("korrelo-mesatta-8452004c:commit-af66af14684e", null)
    .withLastDeployStatus("indeterminate");
}

describe("ReconcileProjectStateUseCase", () => {
  function build(project: Project, state: ProductionContainerState) {
    const repo = new FakeProjectRepository(project);
    const orchestrator = new FakeOrchestrator();
    orchestrator.state = state;
    const useCase = new ReconcileProjectStateUseCase(repo as any, orchestrator as any);
    return { repo, orchestrator, useCase };
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
    // Não inventa imagem quando não há container.
    expect(result.currentImage).toBe("korrelo-mesatta-8452004c:commit-af66af14684e");
  });

  it("container comprovado: adota a imagem real e libera novos deploys", async () => {
    const project = indeterminateProject();
    const state: ProductionContainerState = {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:commit-real123456",
      imageId: "sha256:abc",
    };
    const { useCase } = build(project, state);

    const result = await useCase.execute(project.id);

    expect(result.lastDeployStatus).toBe("failed");
    expect(result.currentImage).toBe("korrelo-mesatta-8452004c:commit-real123456");
    expect(result.status).toBe("running");
  });

  it("recusa tag 'latest' (não é referência versionada)", async () => {
    const project = indeterminateProject();
    const { useCase, repo } = build(project, {
      kind: "known",
      containerId: "c1",
      imageReference: "korrelo-mesatta-8452004c:latest",
      imageId: "sha256:abc",
    });

    await expect(useCase.execute(project.id)).rejects.toThrow(/não é uma tag versionada/);
    expect(repo.saved).toHaveLength(0);
  });
});
