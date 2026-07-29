import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@korrelo/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class PhpDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "PHP";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 8000;
    const lines = [
      "FROM php:8.3-cli-alpine",
      "WORKDIR /app",
      "RUN apk add --no-cache git unzip",
      "COPY . .",
      "RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
      "RUN [ -f composer.json ] && composer install --no-dev --optimize-autoloader --no-interaction || true",
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      `CMD ["sh", "-c", "${stack.startCommand ?? `php -S 0.0.0.0:${port}`}"]`,
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: ["vendor", ".git", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
