import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

const NODE_BASE_IMAGE = "node:20-alpine";

function installCommand(packageManager: string | null): string {
  switch (packageManager) {
    case "yarn":
      return "RUN corepack enable && yarn install --frozen-lockfile || yarn install";
    case "pnpm":
      return "RUN corepack enable && pnpm install --frozen-lockfile || pnpm install";
    case "bun":
      // bun não vem na imagem node:alpine; instalar via npm é o fallback mais leve
      // possível sem trocar a imagem base inteira.
      return "RUN npm install -g bun && bun install";
    default:
      return "RUN npm install";
  }
}

@Injectable()
export class NodeDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Node.js";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 3000;
    const lines = [
      `FROM ${NODE_BASE_IMAGE}`,
      "WORKDIR /app",
      "COPY . .",
      installCommand(stack.packageManager),
    ];

    if (stack.buildCommand) {
      lines.push(`RUN ${stack.buildCommand}`);
    }

    lines.push(
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      `CMD ["sh", "-c", "${stack.startCommand ?? "npm run start"}"]`,
    );

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore:
        // .env.forgedesk carrega segredos do projeto: env_file já injeta essas
        // variáveis no container em runtime, então o arquivo NUNCA deve ser copiado
        // pra dentro da imagem (senão fica gravado permanentemente numa camada).
        ["node_modules", ".git", ".next", "dist", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") +
        "\n",
    };
  }
}
