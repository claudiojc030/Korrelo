import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { Project } from "../domain/project.entity";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../domain/project.repository";
import { DOCKERFILE_GENERATOR, type DockerfileGenerator } from "../domain/dockerfile-generator";
import {
  CONTAINER_ORCHESTRATOR,
  COMPOSE_FILENAME,
  type ContainerOrchestrator,
} from "../domain/container-orchestrator";
import { PortAllocator } from "../infrastructure/port-allocator";
import { ResourceBudgetCalculator } from "../infrastructure/resource-budget-calculator";
import { DockerComposeFileBuilder } from "../infrastructure/docker-compose-file-builder";
import { getProjectWorkspacePath } from "../infrastructure/workspace-paths";

function sanitizeContainerName(projectId: string, projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `forgedesk-${slug || "project"}-${projectId.slice(0, 8)}`;
}

@Injectable()
export class DeployProjectUseCase {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(DOCKERFILE_GENERATOR) private readonly dockerfileGenerator: DockerfileGenerator,
    @Inject(CONTAINER_ORCHESTRATOR) private readonly orchestrator: ContainerOrchestrator,
    private readonly portAllocator: PortAllocator,
    private readonly resourceBudget: ResourceBudgetCalculator,
    private readonly composeFileBuilder: DockerComposeFileBuilder,
  ) {}

  async execute(projectId: string): Promise<Project> {
    const project = await this.repository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projeto ${projectId} não encontrado`);
    }
    if (!project.detectedStack) {
      throw new BadRequestException(
        "Este projeto ainda não tem stack detectada. Rode /import ou /detect-stack antes do deploy.",
      );
    }

    const stack = JSON.parse(project.detectedStack) as DetectedStack;
    const projectPath = getProjectWorkspacePath(project.id);

    const { dockerfile, dockerignore } = this.dockerfileGenerator.generate(stack);
    await fs.writeFile(path.join(projectPath, "Dockerfile"), dockerfile, "utf-8");
    await fs.writeFile(path.join(projectPath, ".dockerignore"), dockerignore, "utf-8");

    const containerPort = stack.recommendedPort ?? 3000;
    const hostPort = await this.portAllocator.allocate(containerPort);
    const containerName = sanitizeContainerName(project.id, project.name);
    const memoryLimitMb = this.resourceBudget.getContainerMemoryLimitMb();

    const deployConfig = {
      projectPath,
      containerName,
      hostPort,
      containerPort,
      memoryLimitMb,
    };

    const composeContent = this.composeFileBuilder.build(deployConfig);
    await fs.writeFile(path.join(projectPath, COMPOSE_FILENAME), composeContent, "utf-8");

    try {
      await this.orchestrator.deploy(deployConfig);
    } catch (error) {
      await this.repository.save(project.withFailedDeployment());
      throw error;
    }

    const deployedProject = project.withDeployment(containerName, hostPort);
    return this.repository.save(deployedProject);
  }
}
