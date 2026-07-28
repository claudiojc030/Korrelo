import { Injectable } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { COMPOSE_FILENAME, ENV_FILENAME } from "../domain/container-orchestrator";

@Injectable()
export class PythonDockerfileGenerator implements DockerfileGenerator {
  supports(stack: DetectedStack): boolean {
    return stack.language === "Python";
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const port = stack.recommendedPort ?? 5000;
    const lines = [
      "FROM python:3.12-slim",
      "WORKDIR /app",
      "COPY . .",
      // Aceita tanto requirements.txt (a maioria dos projetos) quanto pyproject.toml
      // (Poetry/PDM etc) sem precisar saber de antemão qual dos dois existe.
      "RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; " +
        "elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi",
      `EXPOSE ${port}`,
      `ENV PORT=${port}`,
      `CMD ["sh", "-c", "${stack.startCommand ?? "python app.py"}"]`,
    ];

    return {
      dockerfile: lines.join("\n") + "\n",
      dockerignore: ["__pycache__", "*.pyc", ".venv", ".git", ENV_FILENAME, COMPOSE_FILENAME].join("\n") + "\n",
    };
  }
}
