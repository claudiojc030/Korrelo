export type CronJobStatus = "success" | "failed";

export class CronJob {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly name: string,
    public readonly command: string,
    public readonly schedule: string,
    public readonly enabled: boolean,
    public readonly lastRunAt: Date | null,
    public readonly lastStatus: CronJobStatus | null,
    public readonly lastOutput: string | null,
    public readonly createdAt: Date,
  ) {}

  static create(projectId: string, name: string, command: string, schedule: string): CronJob {
    return new CronJob(crypto.randomUUID(), projectId, name, command, schedule, true, null, null, null, new Date());
  }

  withSchedule(name: string, command: string, schedule: string, enabled: boolean): CronJob {
    return new CronJob(
      this.id,
      this.projectId,
      name,
      command,
      schedule,
      enabled,
      this.lastRunAt,
      this.lastStatus,
      this.lastOutput,
      this.createdAt,
    );
  }

  withRunResult(status: CronJobStatus, output: string): CronJob {
    return new CronJob(
      this.id,
      this.projectId,
      this.name,
      this.command,
      this.schedule,
      this.enabled,
      new Date(),
      status,
      output,
      this.createdAt,
    );
  }
}
