import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@korrelo/shared-types";
import type {
  DockerfileGenerator,
  DockerfileGeneratorOptions,
  GeneratedDockerfile,
} from "../domain/dockerfile-generator";
import { ENV_FILENAME, COMPOSE_FILENAME } from "../domain/container-orchestrator";

const NODE_BASE_IMAGE = "node:20-alpine";

/**
 * Comando de instalação de dependências de PRODUÇÃO (sem devDependencies).
 *
 * Feito no estágio "builder" (e não num estágio separado) porque o runner
 * copia o /app inteiro do builder: se o builder terminasse com as devDeps
 * instaladas, elas iam parar na imagem final.
 */
function prodInstallCommand(packageManager: string | null): string {
  switch (packageManager) {
    case "yarn":
      return "yarn install --frozen-lockfile --production=true";
    case "pnpm":
      return "pnpm install --prod --no-frozen-lockfile";
    case "bun":
      return "bun install --production";
    default:
      return "npm prune --omit=dev";
  }
}

/**
 * Dockerfile multi-stage para Node (deps -> builder -> runner).
 *
 * Ganhos (achado DEP-05 da auditoria):
 * - a imagem final NÃO carrega devDependencies (npm prune no builder);
 * - o cache do npm é reaproveitado entre builds (--mount=type=cache) - sem
 *   BuildKit, o Dockerfile cai pra versão clássica (funciona igual, só perde
 *   o cache de pacote);
 * - o build tem um teto de heap (NODE_OPTIONS), porque o build roda FORA de
 *   qualquer cgroup e era um dos maiores consumidores de RAM da VPS;
 * - "npm ci" é usado quando existe package-lock.json (install reprodutível).
 *
 * NOTA: o node_modules NUNCA é copiado entre plataformas diferentes - todos
 * os estágios usam a mesma imagem base (node:20-alpine), então é a mesma
 * plataforma.
 */
@Injectable()
export class NodeDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Node.js";
  }

  generate(stack: DetectedStack, options: DockerfileGeneratorOptions = {}): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 3000;
    const useCacheMounts = options.useCacheMounts === true;
    const buildMemoryMb = Math.max(512, options.buildMemoryMb ?? 1024);
    const packageManager = stack.packageManager;

    const cacheMount = useCacheMounts ? "--mount=type=cache,target=/root/.npm " : "";

    const installCommand = (() => {
      switch (packageManager) {
        case "yarn":
          return "corepack enable && yarn install --frozen-lockfile || yarn install";
        case "pnpm":
          return "corepack enable && pnpm install --frozen-lockfile || pnpm install";
        case "bun":
          // bun não vem na imagem node:alpine; instalar via npm é o fallback mais leve
          // possível sem trocar a imagem base inteira.
          return "npm install -g bun && bun install";
        default:
          // npm ci é reprodutível e usa o lockfile; sem lockfile, cai pro install.
          return "if [ -f package-lock.json ]; then npm ci; else npm install; fi";
      }
    })();

    const lines = [
      `# syntax=docker/dockerfile:1`,
      `# Gerado pelo Korrelo. Imagem multi-stage: deps -> builder -> runner.`,
      `FROM ${NODE_BASE_IMAGE} AS deps`,
      "WORKDIR /app",
      "COPY package.json package-lock.json* ./",
      `RUN ${cacheMount}${installCommand}`,
      "",
      `FROM ${NODE_BASE_IMAGE} AS builder`,
      "WORKDIR /app",
      // Teto de heap do build: o build NÃO roda dentro do mem_limit do
      // container, então sem este limite ele pode consumir a RAM inteira da
      // VPS (e derrubar o que está rodando).
      `ENV NODE_OPTIONS="--max-old-space-size=${buildMemoryMb}"`,
      "COPY --from=deps /app/node_modules ./node_modules",
      "COPY . .",
    ];

    if (stack.buildCommand) {
      lines.push(`RUN ${stack.buildCommand}`);
    }

    // Só as dependências de runtime vão para a imagem final.
    lines.push(`RUN ${prodInstallCommand(packageManager)}`);

    lines.push(
      "",
      `FROM ${NODE_BASE_IMAGE} AS runner`,
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      // node:20-alpine só traz a libssl que o próprio Node usa internamente, não
      // o binário "openssl" de linha de comando - apps que chamam openssl via
      // shell (comum em assinatura de certificado digital, ex.: NFC-e) falham
      // com "Could not find openssl on your system" sem isso.
      "RUN apk add --no-cache openssl",
      `ENV PORT=${port}`,
      "COPY --from=builder /app ./",
      `EXPOSE ${port}`,
      `CMD ["sh", "-c", "${stack.startCommand ?? "npm run start"}"]`,
    );

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore:
        // .env.korrelo carrega segredos do projeto: env_file já injeta essas
        // variáveis no container em runtime, então o arquivo NUNCA deve ser copiado
        // pra dentro da imagem (senão fica gravado permanentemente numa camada).
        ["node_modules", ".git", ".next", "dist", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") +
        "\n",
    };
  }
}
