export const CRON_JOB_RUNNER = Symbol("CRON_JOB_RUNNER");

export interface CronJobRunResult {
  status: "success" | "failed";
  output: string;
}

export interface CronJobRunner {
  run(containerName: string, command: string): Promise<CronJobRunResult>;
}
