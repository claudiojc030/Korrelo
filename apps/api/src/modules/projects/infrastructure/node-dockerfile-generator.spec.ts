import { NODE_BASE_IMAGE, NodeDockerfileGenerator } from "./node-dockerfile-generator";

/**
 * A imagem base dos projetos Node precisa estar na linha corrigida do
 * ciclo de outubro/2026 (CVE-2026-111497). Trocar isto NÃO reconstrói
 * containers existentes: só vale no próximo deploy.
 */
describe("NodeDockerfileGenerator (imagem base)", () => {
  const stack = {
    language: "Node.js",
    framework: "Next.js",
    packageManager: "npm",
    buildCommand: "npm run build",
    startCommand: "npm run start",
    recommendedPort: 3000,
    confidence: "high",
    detectedAt: new Date().toISOString(),
  } as any;

  it("usa a imagem corrigida da linha 22", () => {
    expect(NODE_BASE_IMAGE).toBe("node:22.23.4-alpine");

    const { dockerfile } = new NodeDockerfileGenerator().generate(stack);

    expect(dockerfile).toContain(`FROM ${NODE_BASE_IMAGE} AS deps`);
    expect(dockerfile).toContain(`FROM ${NODE_BASE_IMAGE} AS builder`);
    expect(dockerfile).toContain(`FROM ${NODE_BASE_IMAGE} AS runner`);
    expect(dockerfile).not.toContain("node:20");
  });

  it("mantém o build reprodutível e a imagem final sem devDependencies", () => {
    const { dockerfile } = new NodeDockerfileGenerator().generate(stack, { buildMemoryMb: 700 });

    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(dockerfile).toContain("--max-old-space-size=700");
    expect(dockerfile).toContain("EXPOSE 3000");
  });
});
