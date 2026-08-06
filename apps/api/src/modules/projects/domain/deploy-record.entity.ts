export type DeployStatus = "running" | "success" | "failed";
export type DeployTrigger = "manual" | "webhook";

export class DeployRecord {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly status: DeployStatus,
    public readonly triggeredBy: DeployTrigger,
    public readonly errorMessage: string | null,
    public readonly log: string,
    public readonly commitHash: string | null,
    public readonly commitMessage: string | null,
    public readonly startedAt: Date,
    public readonly finishedAt: Date | null,
  ) {}

  static start(projectId: string, triggeredBy: DeployTrigger): DeployRecord {
    return new DeployRecord(crypto.randomUUID(), projectId, "running", triggeredBy, null, "", null, null, new Date(), null);
  }

  // Anexado fase a fase (staging build, promote) pra dar visibilidade real do
  // andamento do deploy, não só o resultado final.
  appendLog(chunk: string): DeployRecord {
    const log = this.log ? `${this.log}\n${chunk}` : chunk;
    return new DeployRecord(
      this.id,
      this.projectId,
      this.status,
      this.triggeredBy,
      this.errorMessage,
      log,
      this.commitHash,
      this.commitMessage,
      this.startedAt,
      this.finishedAt,
    );
  }

  withCommit(hash: string, message: string): DeployRecord {
    return new DeployRecord(
      this.id,
      this.projectId,
      this.status,
      this.triggeredBy,
      this.errorMessage,
      this.log,
      hash,
      message,
      this.startedAt,
      this.finishedAt,
    );
  }

  withResult(status: "success" | "failed", errorMessage: string | null): DeployRecord {
    return new DeployRecord(
      this.id,
      this.projectId,
      status,
      this.triggeredBy,
      errorMessage,
      this.log,
      this.commitHash,
      this.commitMessage,
      this.startedAt,
      new Date(),
    );
  }
}
