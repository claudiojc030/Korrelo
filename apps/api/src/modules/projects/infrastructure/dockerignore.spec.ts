import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureDockerignore,
  mergeDockerignore,
  REQUIRED_DOCKERIGNORE_ENTRIES,
} from "./dockerignore";
import { NodeDockerfileGenerator } from "./node-dockerfile-generator";

/**
 * O arquivo de ambiente do projeto (.env.korrelo) e o compose do projeto
 * (que tem a senha do banco em texto puro) NUNCA podem entrar no contexto
 * de build - nem quando o projeto traz o próprio Dockerfile (achado DEP-06).
 */
describe("dockerignore", () => {
  it("acrescenta as entradas obrigatórias sem apagar o que o projeto tinha", () => {
    const existing = "node_modules\n# comentário do dono\ndist\n";
    const { content, added } = mergeDockerignore(existing, REQUIRED_DOCKERIGNORE_ENTRIES);

    expect(content).toContain("node_modules");
    expect(content).toContain("# comentário do dono");
    expect(content).toContain("dist");
    expect(content).toContain(".env.korrelo");
    expect(content).toContain("docker-compose.korrelo.yml");
    expect(added).toContain(".env.korrelo");
  });

  it("não duplica entrada que já existe", () => {
    const existing = ".env.korrelo\nnode_modules\n";
    const { content, added } = mergeDockerignore(existing, REQUIRED_DOCKERIGNORE_ENTRIES);

    expect(added).not.toContain(".env.korrelo");
    expect(content.match(/\.env\.korrelo/g)?.length).toBe(1);
  });

  it("cria o arquivo quando o projeto não tem um", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-di-"));
    try {
      const result = await ensureDockerignore(dir);
      expect(result.changed).toBe(true);
      const content = fs.readFileSync(path.join(dir, ".dockerignore"), "utf-8");
      expect(content).toContain(".env.korrelo");
      expect(content).toContain("docker-compose.korrelo.yml");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva o .dockerignore existente do projeto", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-di-"));
    try {
      fs.writeFileSync(path.join(dir, ".dockerignore"), "*.log\nminha-pasta/\n");
      const result = await ensureDockerignore(dir);
      expect(result.changed).toBe(true);
      const content = fs.readFileSync(path.join(dir, ".dockerignore"), "utf-8");
      expect(content).toContain("*.log");
      expect(content).toContain("minha-pasta/");
      expect(content).toContain(".env.korrelo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o Dockerfile gerado também exclui o .env.korrelo do contexto", () => {
    const generator = new NodeDockerfileGenerator();
    const { dockerignore } = generator.generate({
      language: "Node.js",
      framework: "Express",
      packageManager: "npm",
      recommendedPort: 3000,
      startCommand: "npm run start",
      buildCommand: null,
      entryPoint: null,
    });
    expect(dockerignore).toContain(".env.korrelo");
    expect(dockerignore).toContain("docker-compose.korrelo.yml");
  });
});
