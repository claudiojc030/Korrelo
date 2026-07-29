import type { DetectedStack } from "@korrelo/shared-types";

export const DOCKERFILE_GENERATOR = Symbol("DOCKERFILE_GENERATOR");

export interface GeneratedDockerfile {
  dockerfile: string;
  dockerignore: string;
}

export interface DockerfileGenerator {
  supports(stack: DetectedStack): boolean;
  generate(stack: DetectedStack): GeneratedDockerfile;
}
