import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DetectedStack } from "../domain/detected-stack";
import type { StackDetector } from "../domain/stack-detector";

interface FrameworkRule {
  framework: string;
  dependency: string;
  defaultPort: number;
  startCommand: string;
  buildCommand: string | null;
}

const NODE_FRAMEWORK_RULES: FrameworkRule[] = [
  { framework: "Next.js", dependency: "next", defaultPort: 3000, startCommand: "npm run start", buildCommand: "npm run build" },
  { framework: "NestJS", dependency: "@nestjs/core", defaultPort: 3000, startCommand: "npm run start:prod", buildCommand: "npm run build" },
  { framework: "Angular", dependency: "@angular/core", defaultPort: 4200, startCommand: "npm run start", buildCommand: "npm run build" },
  { framework: "Nuxt", dependency: "nuxt", defaultPort: 3000, startCommand: "npm run start", buildCommand: "npm run build" },
  { framework: "Vue", dependency: "vue", defaultPort: 5173, startCommand: "npm run preview", buildCommand: "npm run build" },
  { framework: "Fastify", dependency: "fastify", defaultPort: 3000, startCommand: "npm run start", buildCommand: null },
  { framework: "Express", dependency: "express", defaultPort: 3000, startCommand: "npm run start", buildCommand: null },
  { framework: "React", dependency: "react", defaultPort: 3000, startCommand: "npm run start", buildCommand: "npm run build" },
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

@Injectable()
export class FileBasedStackDetector implements StackDetector {
  async detect(projectPath: string): Promise<DetectedStack> {
    const packageJsonPath = path.join(projectPath, "package.json");
    if (await fileExists(packageJsonPath)) {
      return this.detectNode(projectPath, packageJsonPath);
    }

    if (await fileExists(path.join(projectPath, "composer.json"))) {
      return this.detectPhp(projectPath);
    }

    if (
      (await fileExists(path.join(projectPath, "requirements.txt"))) ||
      (await fileExists(path.join(projectPath, "pyproject.toml")))
    ) {
      return this.detectPython(projectPath);
    }

    if (await fileExists(path.join(projectPath, "go.mod"))) {
      return this.unknownFrameworkStack("Go", null);
    }

    if (await fileExists(path.join(projectPath, "Cargo.toml"))) {
      return this.unknownFrameworkStack("Rust", null);
    }

    if (
      (await fileExists(path.join(projectPath, "pom.xml"))) ||
      (await fileExists(path.join(projectPath, "build.gradle")))
    ) {
      return this.unknownFrameworkStack("Java", null);
    }

    return this.unknownFrameworkStack("Desconhecida", null);
  }

  private async detectNode(projectPath: string, packageJsonPath: string): Promise<DetectedStack> {
    const packageJson = (await readJson(packageJsonPath)) ?? {};
    const deps = {
      ...(packageJson.dependencies as Record<string, string> | undefined),
      ...(packageJson.devDependencies as Record<string, string> | undefined),
    };

    const rule = NODE_FRAMEWORK_RULES.find((r) => deps[r.dependency] !== undefined);
    const packageManager = await this.detectNodePackageManager(projectPath);

    if (!rule) {
      return {
        language: "Node.js",
        framework: null,
        packageManager,
        recommendedPort: 3000,
        startCommand: "npm run start",
        buildCommand: null,
      };
    }

    return {
      language: "Node.js",
      framework: rule.framework,
      packageManager,
      recommendedPort: rule.defaultPort,
      startCommand: rule.startCommand,
      buildCommand: rule.buildCommand,
    };
  }

  private async detectNodePackageManager(projectPath: string): Promise<string> {
    if (await fileExists(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(path.join(projectPath, "yarn.lock"))) return "yarn";
    if (await fileExists(path.join(projectPath, "bun.lockb"))) return "bun";
    return "npm";
  }

  private async detectPhp(projectPath: string): Promise<DetectedStack> {
    const composerJson = (await readJson(path.join(projectPath, "composer.json"))) ?? {};
    const require = (composerJson.require as Record<string, string> | undefined) ?? {};
    const isLaravel = require["laravel/framework"] !== undefined;

    return {
      language: "PHP",
      framework: isLaravel ? "Laravel" : null,
      packageManager: "composer",
      recommendedPort: 8000,
      startCommand: isLaravel ? "php artisan serve" : "php -S 0.0.0.0:8000",
      buildCommand: null,
    };
  }

  private async detectPython(projectPath: string): Promise<DetectedStack> {
    const requirementsPath = path.join(projectPath, "requirements.txt");
    let requirements = "";
    if (await fileExists(requirementsPath)) {
      requirements = (await fs.readFile(requirementsPath, "utf-8")).toLowerCase();
    }

    const framework = requirements.includes("django")
      ? "Django"
      : requirements.includes("flask")
        ? "Flask"
        : requirements.includes("fastapi")
          ? "FastAPI"
          : null;

    return {
      language: "Python",
      framework,
      packageManager: "pip",
      recommendedPort: framework === "Django" ? 8000 : 5000,
      startCommand:
        framework === "Django"
          ? "python manage.py runserver 0.0.0.0:8000"
          : framework === "FastAPI"
            ? "uvicorn main:app --host 0.0.0.0"
            : "python app.py",
      buildCommand: null,
    };
  }

  private unknownFrameworkStack(language: string, framework: string | null): DetectedStack {
    return {
      language,
      framework,
      packageManager: null,
      recommendedPort: null,
      startCommand: null,
      buildCommand: null,
    };
  }
}
