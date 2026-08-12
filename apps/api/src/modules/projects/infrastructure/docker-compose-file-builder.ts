import { Injectable } from "@nestjs/common";
import type { DeployConfig } from "../domain/container-orchestrator";
import { ENV_FILENAME } from "../domain/container-orchestrator";

const LOGGING_BLOCK = [
  // Sem isso, logs de containers enchem o disco silenciosamente numa VPS
  // pequena. Retenção curta e rotacionada por padrão em todo deploy.
  "    logging:",
  '      driver: "json-file"',
  "      options:",
  '        max-size: "10m"',
  '        max-file: "3"',
];

// Caminho fixo dentro do container pro projeto guardar arquivo que não é
// código nem banco (ex.: vídeo/imagem enviado por usuário). Fica num volume
// nomeado, então sobrevive a redeploy (diferente do resto do container, que
// é recriado do zero a cada build) e o backup.js sabe exatamente onde copiar.
const UPLOADS_VOLUME = "uploads-data";
const UPLOADS_MOUNT_PATH = "/app/uploads";

// O V8 (motor JS do Node) decide sozinho o tamanho do heap baseado na RAM
// TOTAL da VPS que ele enxerga, não no mem_limit do container (o cgroup não
// é considerado pra esse cálculo por padrão). Numa VPS de 3.8GB com container
// limitado a 512MB, o V8 podia tentar crescer o heap além do que o container
// realmente tem, morrendo com "heap out of memory" antes do Docker sequer
// precisar matar o processo por estourar o cgroup. Reserva ~25% pra
// stack/buffers/módulos nativos fora do heap do V8.
function nodeOptionsFor(memoryLimitMb: number): string {
  const heapMb = Math.max(128, Math.round(memoryLimitMb * 0.75));
  return `--max-old-space-size=${heapMb}`;
}

@Injectable()
export class DockerComposeFileBuilder {
  build(config: DeployConfig): string {
    const volumeNames = [UPLOADS_VOLUME];

    const dependsOnDb = config.database ? ["    depends_on:", "      - db"] : [];
    const nodeOptions = nodeOptionsFor(config.memoryLimitMb);

    const lines = [
      "services:",
      "  app:",
      "    build: .",
      `    container_name: ${config.containerName}`,
      "    restart: unless-stopped",
      "    env_file:",
      `      - ${ENV_FILENAME}`,
      "    environment:",
      `      NODE_OPTIONS: "${nodeOptions}"`,
      "    ports:",
      // Bind só em 127.0.0.1: sem isso o Docker publica em 0.0.0.0 e
      // IGNORA o ufw pra portas mapeadas via -p/ports (o Docker mexe direto
      // no iptables, por fora do ufw) - a porta ficava acessível pela
      // internet direto por IP:porta, em HTTP puro, pulando o Nginx (TLS +
      // domínio). O Nginx já fala com o container por 127.0.0.1 mesmo.
      `      - "127.0.0.1:${config.hostPort}:${config.containerPort}"`,
      "    volumes:",
      `      - ${UPLOADS_VOLUME}:${UPLOADS_MOUNT_PATH}`,
      `    mem_limit: ${config.memoryLimitMb}m`,
      ...dependsOnDb,
      ...LOGGING_BLOCK,
      // Instância de teste (deploy sem downtime, ver DeployProjectUseCase):
      // mesma imagem/contexto de build do "app", porta e nome à parte, pra
      // validar antes de tocar na versão em produção.
      "  app_staging:",
      "    build: .",
      `    container_name: ${config.staging.containerName}`,
      "    restart: unless-stopped",
      "    env_file:",
      `      - ${ENV_FILENAME}`,
      "    environment:",
      `      NODE_OPTIONS: "${nodeOptions}"`,
      "    ports:",
      `      - "127.0.0.1:${config.staging.hostPort}:${config.containerPort}"`,
      "    volumes:",
      `      - ${UPLOADS_VOLUME}:${UPLOADS_MOUNT_PATH}`,
      `    mem_limit: ${config.memoryLimitMb}m`,
      ...dependsOnDb,
      ...LOGGING_BLOCK,
    ];

    if (config.database) {
      const { serviceLines, volumeName } = this.buildDatabaseService(config.database);
      lines.push(...serviceLines);
      if (volumeName) volumeNames.push(volumeName);
    }

    lines.push("volumes:");
    for (const name of volumeNames) {
      lines.push(`  ${name}:`);
    }

    lines.push("");
    return lines.join("\n");
  }

  private buildDatabaseService(db: NonNullable<DeployConfig["database"]>): {
    serviceLines: string[];
    volumeName: string | null;
  } {
    if (db.type === "postgres") {
      return {
        volumeName: "db-data",
        serviceLines: [
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
        ],
      };
    }

    if (db.type === "redis") {
      const command = db.persistent
        ? [
            "redis-server",
            "--requirepass",
            db.password,
            "--maxmemory",
            `${db.memoryLimitMb}mb`,
            "--maxmemory-policy",
            "allkeys-lru",
            // Sem persistência por padrão (é cache/fila). Só liga RDB+AOF
            // quando o projeto marcou esse Redis como "guarda dado importante".
            "--save",
            "60",
            "1000",
            "--appendonly",
            "yes",
          ]
        : [
            "redis-server",
            "--requirepass",
            db.password,
            "--maxmemory",
            `${db.memoryLimitMb}mb`,
            "--maxmemory-policy",
            "allkeys-lru",
          ];

      return {
        volumeName: db.persistent ? "db-data" : null,
        serviceLines: [
          "  db:",
          "    image: redis:7-alpine",
          "    restart: unless-stopped",
          `    command: [${command.map((c) => `"${c}"`).join(", ")}]`,
          `    mem_limit: ${db.memoryLimitMb}m`,
          ...(db.persistent ? ["    volumes:", "      - db-data:/data"] : []),
          ...LOGGING_BLOCK,
        ],
      };
    }

    return {
      volumeName: "db-data",
      serviceLines: [
        "  db:",
        "    image: mongo:7",
        "    restart: unless-stopped",
        // Sem --quiet o mongod loga toda conexão aceita/encerrada e evento de
        // autenticação - com o driver do app reconectando com frequência, isso
        // enche a aba de Logs com centenas de linhas irrelevantes pra quem só
        // quer ver se o banco está de pé.
        '    command: ["mongod", "--quiet"]',
        "    environment:",
        `      MONGO_INITDB_ROOT_USERNAME: ${db.username}`,
        `      MONGO_INITDB_ROOT_PASSWORD: ${db.password}`,
        `      MONGO_INITDB_DATABASE: ${db.databaseName}`,
        "    volumes:",
        "      - db-data:/data/db",
        `    mem_limit: ${db.memoryLimitMb}m`,
        ...LOGGING_BLOCK,
      ],
    };
  }
}
