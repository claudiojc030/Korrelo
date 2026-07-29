import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@korrelo/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class DotnetDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === ".NET";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 8080;
    const lines = [
      "FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build",
      "WORKDIR /app",
      "COPY . .",
      "RUN dotnet publish -c Release -o /out",
      "",
      "FROM mcr.microsoft.com/dotnet/aspnet:8.0",
      "WORKDIR /app",
      "COPY --from=build /out .",
      `EXPOSE ${port}`,
      `ENV ASPNETCORE_URLS=http://+:${port}`,
      // Evita precisar saber o nome exato do .dll (igual ao nome do .csproj,
      // que a gente não parseia). Acha o único .dll publicado em runtime.
      'CMD ["sh", "-c", "dotnet $(ls *.dll | head -n 1)"]',
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: ["bin", "obj", ".git", "*.log", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
