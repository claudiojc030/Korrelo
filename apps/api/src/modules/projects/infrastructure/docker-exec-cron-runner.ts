import { Injectable } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { CronJobRunner, CronJobRunResult } from "../domain/cron-job-runner";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_CHARS = 20_000;

@Injectable()
export class DockerExecCronRunner implements CronJobRunner {
  async run(containerName: string, command: string): Promise<CronJobRunResult> {
    try {
      const { stdout, stderr } = await execFile("docker", ["exec", containerName, "sh", "-c", command], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n").slice(-MAX_OUTPUT_CHARS);
      return { status: "success", output };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(-MAX_OUTPUT_CHARS);
      return { status: "failed", output };
    }
  }
}
