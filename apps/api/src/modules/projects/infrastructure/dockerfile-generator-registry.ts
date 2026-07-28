import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { DetectedStack } from "@forgedesk/shared-types";
import type { DockerfileGenerator, GeneratedDockerfile } from "../domain/dockerfile-generator";
import { NodeDockerfileGenerator } from "./node-dockerfile-generator";

@Injectable()
export class DockerfileGeneratorRegistry implements DockerfileGenerator {
  private readonly generators: DockerfileGenerator[];

  constructor(nodeDockerfileGenerator: NodeDockerfileGenerator) {
    this.generators = [nodeDockerfileGenerator];
  }

  supports(stack: DetectedStack): boolean {
    return this.generators.some((g) => g.supports(stack));
  }

  generate(stack: DetectedStack): GeneratedDockerfile {
    const generator = this.generators.find((g) => g.supports(stack));
    if (!generator) {
      throw new UnprocessableEntityException(
        `Auto Setup ainda não suporta a stack "${stack.language}"${stack.framework ? ` (${stack.framework})` : ""}. ` +
          "Suporte disponível hoje: Node.js.",
      );
    }
    return generator.generate(stack);
  }
}
