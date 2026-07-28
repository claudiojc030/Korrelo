import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class RustDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Rust";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 8080;
    // entryPoint vem do nome do pacote lido do Cargo.toml (ver
    // file-based-stack-detector.ts) — é o nome do binário que `cargo build`
    // gera em target/release/.
    const binaryName = stack.entryPoint ?? "app";
    const lines = [
      "FROM rust:1.79-alpine AS build",
      "WORKDIR /app",
      "RUN apk add --no-cache musl-dev",
      "COPY . .",
      "RUN cargo build --release",
      "",
      "FROM alpine:3.20",
      "WORKDIR /app",
      `COPY --from=build /app/target/release/${binaryName} ./app`,
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      'CMD ["./app"]',
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: ["target", ".git", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
