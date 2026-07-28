import { Injectable } from "@nestjs/common";
import type { DeployConfig } from "../domain/container-orchestrator";
import { ENV_FILENAME } from "../domain/container-orchestrator";

const LOGGING_BLOCK = [
  // Sem isso, logs de containers enchem o disco silenciosamente numa VPS
  // pequena — retenção curta e rotacionada por padrão em todo deploy.
  "    logging:",
  '      driver: "json-file"',
  "      options:",
  '        max-size: "10m"',
  '        max-file: "3"',
];

@Injectable()
export class DockerComposeFileBuilder {
  build(config: DeployConfig): string {
    const lines = [
      "services:",
      "  app:",
      "    build: .",
      `    container_name: ${config.containerName}`,
      "    restart: unless-stopped",
      "    env_file:",
      `      - ${ENV_FILENAME}`,
      "    ports:",
      `      - "${config.hostPort}:${config.containerPort}"`,
      `    mem_limit: ${config.memoryLimitMb}m`,
      ...LOGGING_BLOCK,
    ];

    if (config.database) {
      lines.push("    depends_on:", "      - db");
      lines.push(...this.buildDatabaseService(config.database));
    }

    lines.push("");
    return lines.join("\n");
  }

  private buildDatabaseService(db: DeployConfig["database"]): string[] {
    if (!db) return [];

    if (db.type === "postgres") {
      return [
        "  db:",
        "    image: postgres:16-alpine",
        // Nome de container fixo (não gerenciado pelo compose com container_name)
        // pra manter o app resolvendo "db" via DNS interno do compose de qualquer forma.
        "    restart: unless-stopped",
        "    environment:",
        `      POSTGRES_USER: ${db.username}`,
        `      POSTGRES_PASSWORD: ${db.password}`,
        `      POSTGRES_DB: ${db.databaseName}`,
        "    volumes:",
        "      - db-data:/var/lib/postgresql/data",
        `    mem_limit: ${db.memoryLimitMb}m`,
        ...LOGGING_BLOCK,
        "volumes:",
        "  db-data:",
      ];
    }

    if (db.type === "redis") {
      return [
        "  db:",
        "    image: redis:7-alpine",
        "    restart: unless-stopped",
        `    command: ["redis-server", "--requirepass", "${db.password}", "--maxmemory", "${db.memoryLimitMb}mb", "--maxmemory-policy", "allkeys-lru"]`,
        `    mem_limit: ${db.memoryLimitMb}m`,
        ...LOGGING_BLOCK,
      ];
    }

    return [
      "  db:",
      "    image: mongo:7",
      "    restart: unless-stopped",
      "    environment:",
      `      MONGO_INITDB_ROOT_USERNAME: ${db.username}`,
      `      MONGO_INITDB_ROOT_PASSWORD: ${db.password}`,
      `      MONGO_INITDB_DATABASE: ${db.databaseName}`,
      "    volumes:",
      "      - db-data:/data/db",
      `    mem_limit: ${db.memoryLimitMb}m`,
      ...LOGGING_BLOCK,
      "volumes:",
      "  db-data:",
    ];
  }
}
