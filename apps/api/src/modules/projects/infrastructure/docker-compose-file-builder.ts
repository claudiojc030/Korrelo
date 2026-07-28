import { Injectable } from "@nestjs/common";
import type { DeployConfig } from "../domain/container-orchestrator";

@Injectable()
export class DockerComposeFileBuilder {
  build(config: DeployConfig): string {
    return [
      "services:",
      "  app:",
      "    build: .",
      `    container_name: ${config.containerName}`,
      "    restart: unless-stopped",
      "    ports:",
      `      - "${config.hostPort}:${config.containerPort}"`,
      `    mem_limit: ${config.memoryLimitMb}m`,
      // Sem isso, logs de containers enchem o disco silenciosamente numa VPS
      // pequena — retenção curta e rotacionada por padrão em todo deploy.
      "    logging:",
      '      driver: "json-file"',
      "      options:",
      '        max-size: "10m"',
      '        max-file: "3"',
      "",
    ].join("\n");
  }
}
