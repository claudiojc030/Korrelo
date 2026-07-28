import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { NodeDockerfileGenerator } from "./node-dockerfile-generator";
import { PhpDockerfileGenerator } from "./php-dockerfile-generator";
import { PythonDockerfileGenerator } from "./python-dockerfile-generator";
import { GoDockerfileGenerator } from "./go-dockerfile-generator";
import { RustDockerfileGenerator } from "./rust-dockerfile-generator";
import { JavaDockerfileGenerator } from "./java-dockerfile-generator";
import { DotnetDockerfileGenerator } from "./dotnet-dockerfile-generator";

@Injectable()
export class DockerfileGeneratorRegistry implements DockerfileGenerator {
  private readonly generators: DockerfileGenerator[];

  constructor(
    nodeDockerfileGenerator: NodeDockerfileGenerator,
    phpDockerfileGenerator: PhpDockerfileGenerator,
    pythonDockerfileGenerator: PythonDockerfileGenerator,
    goDockerfileGenerator: GoDockerfileGenerator,
    rustDockerfileGenerator: RustDockerfileGenerator,
    javaDockerfileGenerator: JavaDockerfileGenerator,
    dotnetDockerfileGenerator: DotnetDockerfileGenerator,
  ) {
    this.generators = [
      nodeDockerfileGenerator,
      phpDockerfileGenerator,
      pythonDockerfileGenerator,
      goDockerfileGenerator,
      rustDockerfileGenerator,
      javaDockerfileGenerator,
      dotnetDockerfileGenerator,
    ];
  }

  supports(stack: DetectedStack): boolean {
    return this.generators.some((g) => g.supports(stack));
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const generator = this.generators.find((g) => g.supports(stack));
    if (!generator) {
      throw new UnprocessableEntityException(
        `Auto Setup ainda não suporta a stack "${stack.language}"${stack.framework ? ` (${stack.framework})` : ""}. ` +
          "Suporte disponível hoje: Node.js, PHP, Python, Go, Rust, Java, .NET.",
      );
    }
    return generator.generate(stack);
  }
}
