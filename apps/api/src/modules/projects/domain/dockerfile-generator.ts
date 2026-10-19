import type { DetectedStack } from "@korrelo/shared-types";

export const DOCKERFILE_GENERATOR = Symbol("DOCKERFILE_GENERATOR");

export interface GeneratedDockerfile {
  dockerfile: string;
  dockerignore: string;
}

export interface DockerfileGeneratorOptions {
  /**
   * true quando o BuildKit está disponível. Com ele, o Dockerfile pode usar
   * "RUN --mount=type=cache" (cache do npm entre builds) e a sintaxe
   * moderna. Sem BuildKit, o gerador usa o formato clássico (que funciona
   * em qualquer Docker, só perde o cache de pacote).
   */
  useCacheMounts?: boolean;
  /**
   * Teto de heap do Node durante o BUILD (MB). O build roda FORA de qualquer
   * cgroup do container, então um teto explícito evita que ele consuma a
   * RAM inteira da VPS (achado DEP-05).
   */
  buildMemoryMb?: number;
}

export interface DockerfileGenerator {
  supports(stack: DetectedStack): boolean;
  generate(stack: DetectedStack, options?: DockerfileGeneratorOptions): GeneratedDockerfile;
}
