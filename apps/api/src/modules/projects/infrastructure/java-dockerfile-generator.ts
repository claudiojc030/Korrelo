import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class JavaDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Java";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 8080;
    const isGradle = stack.packageManager === "gradle";

    // Simplificação assumida: o build produz um único jar executável em
    // target/ (Maven) ou build/libs/ (Gradle), o caso comum de um projeto
    // Spring Boot com o plugin de repackage. Projetos que geram múltiplos
    // jars (ex: com jar "-sources") podem precisar de ajuste manual.
    const buildStage = isGradle
      ? [
          "FROM gradle:8-jdk21 AS build",
          "WORKDIR /app",
          "COPY . .",
          "RUN gradle build -x test --no-daemon",
        ]
      : [
          "FROM maven:3.9-eclipse-temurin-21 AS build",
          "WORKDIR /app",
          "COPY . .",
          "RUN mvn -B package -DskipTests",
        ];

    const jarGlob = isGradle ? "/app/build/libs/*.jar" : "/app/target/*.jar";

    const lines = [
      ...buildStage,
      "",
      "FROM eclipse-temurin:21-jre-alpine",
      "WORKDIR /app",
      `COPY --from=build ${jarGlob} app.jar`,
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      `CMD ["sh", "-c", "java -jar app.jar --server.port=${port}"]`,
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: ["target", "build", ".git", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
