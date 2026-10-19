import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Assets do Next em modo "standalone".
 *
 * O Next standalone NÃO serve .next/static nem public/ sozinho: o servidor
 * sobe a partir de apps/web/.next/standalone/apps/web/server.js e precisa
 * que esses dois diretórios estejam AO LADO dele. Sem essa cópia, o painel
 * fica sem CSS/JS depois de um update.
 *
 * O teste roda o MESMO script que o build usa (apps/web/scripts/
 * copy-standalone-assets.js), copiado para uma árvore temporária - nada é
 * escrito no repositório.
 */
describe("assets do Next standalone", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
  const SOURCE_SCRIPT = path.join(REPO_ROOT, "apps", "web", "scripts", "copy-standalone-assets.js");

  let tempRoot: string;
  let webDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-assets-"));
    webDir = path.join(tempRoot, "apps", "web");
    fs.mkdirSync(path.join(webDir, "scripts"), { recursive: true });
    fs.copyFileSync(SOURCE_SCRIPT, path.join(webDir, "scripts", "copy-standalone-assets.js"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function runCopyScript(): void {
    execFileSync(process.execPath, [path.join(webDir, "scripts", "copy-standalone-assets.js")], {
      cwd: webDir,
      stdio: "pipe",
    });
  }

  it("copia .next/static e public/ para o standalone", () => {
    fs.mkdirSync(path.join(webDir, ".next", "static", "chunks"), { recursive: true });
    fs.writeFileSync(path.join(webDir, ".next", "static", "chunks", "app.js"), "console.log(1)");
    fs.mkdirSync(path.join(webDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(webDir, "public", "favicon.ico"), "icone");

    runCopyScript();

    const standalone = path.join(webDir, ".next", "standalone", "apps", "web");
    expect(fs.existsSync(path.join(standalone, ".next", "static", "chunks", "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, "public", "favicon.ico"))).toBe(true);
  });

  it("não quebra quando public/ não existe", () => {
    fs.mkdirSync(path.join(webDir, ".next", "static"), { recursive: true });
    fs.writeFileSync(path.join(webDir, ".next", "static", "app.js"), "console.log(1)");

    expect(() => runCopyScript()).not.toThrow();
    const standalone = path.join(webDir, ".next", "standalone", "apps", "web");
    expect(fs.existsSync(path.join(standalone, ".next", "static", "app.js"))).toBe(true);
  });

  it("é idempotente (rodar de novo não quebra nem duplica)", () => {
    fs.mkdirSync(path.join(webDir, ".next", "static"), { recursive: true });
    fs.writeFileSync(path.join(webDir, ".next", "static", "app.js"), "console.log(1)");
    fs.mkdirSync(path.join(webDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(webDir, "public", "favicon.ico"), "icone");

    runCopyScript();
    expect(() => runCopyScript()).not.toThrow();

    const standalone = path.join(webDir, ".next", "standalone", "apps", "web");
    expect(fs.existsSync(path.join(standalone, ".next", "static", "app.js"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, "public", "favicon.ico"))).toBe(true);
  });

  it("falha alto se o .next/static não existir (build incompleto)", () => {
    fs.mkdirSync(path.join(webDir, "public"), { recursive: true });
    expect(() => runCopyScript()).toThrow();
  });
});

describe("permissões do Core após o rollout", () => {
  it("600 continua dando acesso ao dono (o mesmo usuário do PM2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-perm-"));
    try {
      const file = path.join(dir, ".env");
      fs.writeFileSync(file, "JWT_SECRET=valor\n");

      fs.chmodSync(file, 0o600);

      // O Windows não implementa bits POSIX de permissão - a validação de
      // modo vale no Linux (a VPS). O acesso do dono é conferido nos dois.
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      // O dono (o usuário que roda o PM2) continua lendo e escrevendo.
      expect(() => fs.accessSync(file, fs.constants.R_OK)).not.toThrow();
      expect(() => fs.accessSync(file, fs.constants.W_OK)).not.toThrow();
      expect(fs.readFileSync(file, "utf-8")).toContain("JWT_SECRET");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o dev.db do Core também pode ir para 600 (SQLite lê pelo dono)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-perm-db-"));
    try {
      const file = path.join(dir, "dev.db");
      fs.writeFileSync(file, "sqlite");

      fs.chmodSync(file, 0o600);

      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(() => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
