import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@korrelo/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class GoDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Go";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 8080;
    const lines = [
      "FROM golang:1.22-alpine AS build",
      "WORKDIR /app",
      "COPY . .",
      "RUN go mod download",
      "RUN go build -o /out/server .",
      "",
      "FROM alpine:3.20",
      "WORKDIR /app",
      "COPY --from=build /out/server .",
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      'CMD ["./server"]',
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: [".git", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
