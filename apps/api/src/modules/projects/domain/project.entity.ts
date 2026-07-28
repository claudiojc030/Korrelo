import type { ProjectStatus } from "@forgedesk/shared-types";

export class Project {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly repoUrl: string,
    public readonly detectedStack: string | null,
    public readonly status: ProjectStatus,
    public readonly createdAt: Date,
  ) {}

  static create(name: string, repoUrl: string): Project {
    return new Project(
      crypto.randomUUID(),
      name,
      repoUrl,
      null,
      "detected",
      new Date(),
    );
  }

  withDetectedStack(detectedStackJson: string): Project {
    return new Project(
      this.id,
      this.name,
      this.repoUrl,
      detectedStackJson,
      "configuring",
      this.createdAt,
    );
  }
}
