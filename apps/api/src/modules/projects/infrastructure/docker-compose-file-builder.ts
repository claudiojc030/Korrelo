import { Injectable } from "@nestjs/common";
import type { DeployConfig, DatabaseServiceConfig, HealthcheckConfig } from "../domain/container-orchestrator";
import { ENV_FILENAME } from "../domain/container-orchestrator";
import {
  STAGING_DEPLOY_ENV_VALUE,
  STAGING_DEPLOY_ENV_VAR,
} from "../domain/staging-config";
import { computeNodeHeapMb } from "./memory-budget";

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

// Rede externa compartilhada por TODOS os projetos, criada uma vez pelo
// orchestrator antes do deploy (ver DockerComposeOrchestrator.ensureSharedNetwork).
// Cada projeto continua com sua rede "default" isolada (pro app falar com o
// próprio banco), mas "app"/"app_staging" entram também nessa rede compartilhada -
// assim um projeto consegue chamar outro pelo nome do container, sem precisar
// expor porta pra internet só pra comunicação interna entre dois projetos do
// mesmo Korrelo.
export const SHARED_NETWORK = "korrelo-shared";

/**
 * Labels aplicadas nos containers gerenciados pelo Korrelo.
 *
 * `korrelo.ephemeral=true` marca o container de STAGING: ele é temporário,
 * não reinicia sozinho e pode ser removido com segurança quando ninguém mais
 * está usando. É o que permite a limpeza de órfãos no startup (sem isso,
 * qualquer `*-staging` encontrado seria removido às cegas).
 */
export const KORRELO_EPHEMERAL_LABEL = "korrelo.ephemeral";
export const KORRELO_PROJECT_LABEL = "korrelo.projectId";
export const KORRELO_DEPLOY_JOB_LABEL = "korrelo.deployJobId";
export const KORRELO_COMMIT_LABEL = "korrelo.commitSha";

/**
 * V8 (motor JS do Node) decide sozinho o tamanho do heap baseado na RAM
 * TOTAL da VPS que ele enxerga, não no mem_limit do container (o cgroup não
 * é considerado pra esse cálculo por padrão). Sem um teto, ele pode tentar
 * crescer o heap além do que o container realmente tem, morrendo com "heap
 * out of memory" antes do Docker sequer precisar matar o processo por
 * estourar o cgroup. A folga (~30%) cobre memória nativa, buffers, threads
 * e o runtime. Ver computeNodeHeapMb.
 */
function nodeOptionsFor(memoryLimitMb: number): string {
  return `--max-old-space-size=${computeNodeHeapMb(memoryLimitMb)}`;
}

function escapeYamlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Comando de healthcheck.
 *
 * Só é usado quando o projeto CONFIGURA um healthcheck (padrão: nenhum) -
 * não dá pra assumir que "/" signifique saúde perfeita em qualquer stack, e
 * um probe errado reiniciaria a aplicação em produção.
 *
 * O probe de Node usa o próprio node (a imagem tem node por definição).
 * Para as outras stacks geradas (alpine) o busybox wget existe; para um
 * Dockerfile customizado de outra stack, quem ativa o healthcheck assume a
 * responsabilidade do comando.
 */
function buildHealthcheckTest(
  language: string | null,
  config: HealthcheckConfig,
  containerPort: number,
): string[] {
  const path = config.path || "/";
  if (language === "Node.js") {
    const script =
      `const http=require('http');` +
      `const req=http.get({host:'127.0.0.1',port:process.env.PORT||${containerPort},path:${JSON.stringify(
        path,
      )},timeout:${Math.max(1, config.timeoutSeconds - 1) * 1000}},r=>process.exit(r.statusCode<500?0:1));` +
      `req.on('error',()=>process.exit(1));` +
      `req.on('timeout',()=>{req.destroy();process.exit(1)});`;
    return ["CMD", "node", "-e", script];
  }
  return ["CMD", "wget", "--spider", "-q", `http://127.0.0.1:${containerPort}${path}`];
}

@Injectable()
export class DockerComposeFileBuilder {
  build(config: DeployConfig, stackLanguage: string | null = null): string {
    const volumeNames = [UPLOADS_VOLUME];

    const dependsOnDb =
      config.databases.length > 0
        ? ["    depends_on:", ...config.databases.map((db) => `      - ${db.serviceName}`)]
        : [];

    const nodeOptions = nodeOptionsFor(config.memoryLimitMb);
    const stagingMemoryLimit = config.staging.memoryLimitMb ?? config.memoryLimitMb;
    const stagingNodeOptions = nodeOptionsFor(stagingMemoryLimit);
    const envFilePath = config.envFilePath ?? ENV_FILENAME;

    const imageName = config.imageName;
    const imageTag = config.imageTag;
    // A tag default do compose é a do deploy atual; o ROLLBACK reusa o
    // mesmo arquivo com KORRELO_IMAGE_TAG apontando pra imagem anterior.
    const imageLine = imageName
      ? `    image: ${imageName}:\${KORRELO_IMAGE_TAG:-${imageTag ?? "latest"}}`
      : null;

    const labels = [
      `      ${KORRELO_PROJECT_LABEL}: "${escapeYamlValue(config.projectId ?? "")}"`,
      `      ${KORRELO_DEPLOY_JOB_LABEL}: "${escapeYamlValue(config.deployJobId ?? "")}"`,
      `      ${KORRELO_COMMIT_LABEL}: "${escapeYamlValue(config.commitSha ?? "")}"`,
    ];

    const stagingLabels = [`      ${KORRELO_EPHEMERAL_LABEL}: "true"`, ...labels];

    const healthcheckBlock = this.buildHealthcheckBlock(config, stackLanguage);
    const stagingHealthcheckBlock = this.buildHealthcheckBlock(config, stackLanguage);    const memswapBlock = this.buildMemswapBlock(config.memoryLimitMb, config.memswapLimitMb);
    const stagingMemswapBlock = this.buildMemswapBlock(stagingMemoryLimit, config.memswapLimitMb);

    const lines = [
      "services:",
      "  app:",
      "    build: .",
      ...(imageLine ? [imageLine] : []),
      `    container_name: ${config.containerName}`,
      "    restart: unless-stopped",
      "    env_file:",
      `      - ${envFilePath}`,
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
      ...memswapBlock,
      "    labels:",
      ...labels,
      "    networks:",
      "      - default",
      `      - ${SHARED_NETWORK}`,
      ...dependsOnDb,
      ...LOGGING_BLOCK,
      ...healthcheckBlock,
      // Instância de teste (deploy sem downtime, ver DeployProjectUseCase):
      // mesma imagem/contexto de build do "app", porta e nome à parte, pra
      // validar antes de tocar na versão em produção.
      "  app_staging:",
      "    build: .",
      ...(imageLine ? [imageLine] : []),
      `    container_name: ${config.staging.containerName}`,
      // SEM política de restart: staging é temporário. Com "unless-stopped",
      // um container de teste que sobrasse (API morta no meio do deploy)
      // voltaria sozinho no boot e ficaria consumindo RAM/porta/banco.
      "    restart: \"no\"",
      "    env_file:",
      `      - ${envFilePath}`,
      // Arquivo EXCLUSIVO do teste (variáveis KORRELO_STAGING_*). A produção
      // nunca recebe este arquivo.
      ...(config.stagingEnvFilePath ? [`      - ${config.stagingEnvFilePath}`] : []),
      "    environment:",
      `      NODE_OPTIONS: "${stagingNodeOptions}"`,
      // Identificação do ambiente de teste. Fica em `environment:` (tem
      // precedência sobre env_file) e SÓ no app_staging: a aplicação pode usar
      // isso para desligar workers/cron/pollers no container de teste.
      `      ${STAGING_DEPLOY_ENV_VAR}: "${STAGING_DEPLOY_ENV_VALUE}"`,
      "    ports:",
      `      - "127.0.0.1:${config.staging.hostPort}:${config.containerPort}"`,
      "    volumes:",
      `      - ${UPLOADS_VOLUME}:${UPLOADS_MOUNT_PATH}`,
      `    mem_limit: ${stagingMemoryLimit}m`,
      ...stagingMemswapBlock,
      "    labels:",
      ...stagingLabels,
      "    networks:",
      "      - default",
      `      - ${SHARED_NETWORK}`,
      ...dependsOnDb,
      ...LOGGING_BLOCK,
      ...stagingHealthcheckBlock,
    ];

    for (const db of config.databases) {
      const { serviceLines, volumeName } = this.buildDatabaseService(db);
      lines.push(...serviceLines);
      if (volumeName) volumeNames.push(volumeName);
    }

    lines.push("volumes:");
    for (const name of volumeNames) {
      lines.push(`  ${name}:`);
    }

    lines.push(
      "networks:",
      "  default:",
      `  ${SHARED_NETWORK}:`,
      "    external: true",
    );

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Healthcheck Docker do container. Só entra no compose quando o projeto
   * CONFIGURA um - o padrão (nenhum healthcheck) mantém o comportamento
   * atual e evita reiniciar aplicação por lentidão transitória.
   */
  private buildHealthcheckBlock(config: DeployConfig, stackLanguage: string | null): string[] {
    const healthcheck = config.healthcheck;
    if (!healthcheck || !healthcheck.enabled) return [];
    return [
      "    healthcheck:",
      `      test: [${buildHealthcheckTest(stackLanguage, healthcheck, config.containerPort)
        .map((part) => JSON.stringify(part))
        .join(", ")}]`,
      `      interval: ${Math.max(5, healthcheck.intervalSeconds)}s`,
      `      timeout: ${Math.max(1, healthcheck.timeoutSeconds)}s`,
      `      retries: ${Math.max(1, healthcheck.retries)}`,
      // start_period: o container é considerado "starting" e NÃO é
      // reiniciado por falha de healthcheck durante esse tempo (app que
      // demora pra subir não entra em loop de restart).
      `      start_period: ${Math.max(0, healthcheck.startPeriodSeconds)}s`,
    ];
  }

  /**
   * Teto de swap do container.
   *
   * SEMÂNTICA (Docker/Compose): com `mem_limit` definido e SEM
   * `memswap_limit`, o container pode usar swap até o DOBRO do mem_limit
   * (mem_limit + mem_limit de swap). Pra proibir swap, `memswap_limit`
   * precisa ser IGUAL ao `mem_limit`. Pra permitir swap além disso, é
   * maior.
   *
   * IMPORTANTE: isso é opcional e DESLIGADO por padrão. Trocar isso sem
   * medir pode matar containers que hoje sobrevivem no swap numa VPS
   * apertada (o OOM killer do cgroup mata antes do swap ajudar). A
   * configuração é feita por variável de ambiente e o comportamento
   * anterior (sem mexer) é o padrão.
   */
  private buildMemswapBlock(memoryLimitMb: number, memswapLimitMb: number | null | undefined): string[] {
    if (!memswapLimitMb || memswapLimitMb <= 0) return [];
    const limit = Math.min(memswapLimitMb, memoryLimitMb);
    return [`    memswap_limit: ${limit}m`];
  }

  private buildDatabaseService(db: DatabaseServiceConfig): {
    serviceLines: string[];
    volumeName: string | null;
  } {
    // Nome do volume derivado do serviço (não fixo "db-data" mais) - com
    // vários bancos no mesmo projeto (ex.: Postgres + Redis), cada um precisa
    // do próprio volume, senão um pisaria no dado do outro.
    const volumeName = `${db.serviceName}-data`;

    if (db.type === "postgres") {
      return {
        volumeName,
        serviceLines: [
          `  ${db.serviceName}:`,
          "    image: postgres:16-alpine",
          "    restart: unless-stopped",
          "    environment:",
          `      POSTGRES_USER: ${db.username}`,
          `      POSTGRES_PASSWORD: ${db.password}`,
          `      POSTGRES_DB: ${db.databaseName}`,
          "    volumes:",
          `      - ${volumeName}:/var/lib/postgresql/data`,
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
        volumeName: db.persistent ? volumeName : null,
        serviceLines: [
          `  ${db.serviceName}:`,
          "    image: redis:7-alpine",
          "    restart: unless-stopped",
          `    command: [${command.map((c) => `"${c}"`).join(", ")}]`,
          `    mem_limit: ${db.memoryLimitMb}m`,
          ...(db.persistent ? ["    volumes:", `      - ${volumeName}:/data`] : []),
          ...LOGGING_BLOCK,
        ],
      };
    }

    return {
      volumeName,
      serviceLines: [
        `  ${db.serviceName}:`,
        "    image: mongo:7",
        "    restart: unless-stopped",
        "    environment:",
        `      MONGO_INITDB_ROOT_USERNAME: ${db.username}`,
        `      MONGO_INITDB_ROOT_PASSWORD: ${db.password}`,
        `      MONGO_INITDB_DATABASE: ${db.databaseName}`,
        "    volumes:",
        `      - ${volumeName}:/data/db`,
        `    mem_limit: ${db.memoryLimitMb}m`,
        ...LOGGING_BLOCK,
      ],
    };
  }
}
