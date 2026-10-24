import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REGRESSÃO DO INSTALADOR LADO A LADO (Node.js 22).
 *
 * Incidente real na VPS: `sudo mktemp -d` cria o staging root:root 0700. A
 * validação do binário extraído era executada como o usuário `korrelo`, que
 * não consegue ATRAVESSAR o diretório -> "Permission denied", abortando a
 * instalação antes de publicar o symlink `current`.
 *
 * A correção mantém o staging fechado (0700) e roda a validação sob sudo.
 * Os testes abaixo travam isso: (1) a checagem estática do script e (2) uma
 * reprodução real do erro de permissão, quando bash + sudo estão disponíveis.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/install-node-runtime.sh");

function codeLines(source: string): string {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
}

function sudoAvailable(): boolean {
  if (process.platform === "win32") return false;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const POSIX_WITH_SUDO = process.platform !== "win32" && sudoAvailable();

describe("install-node-runtime.sh (staging 0700)", () => {
  const script = fs.readFileSync(SCRIPT, "utf-8");
  const code = codeLines(script);

  it("valida o binário extraído sob sudo (staging não é acessível ao usuário)", () => {
    expect(code).toMatch(/sudo "\$STAGING\/\$EXTRACTED\/bin\/node" --version/);
    // Nenhuma execução do binário do staging pode ficar sem sudo.
    const directRuns = code
      .split("\n")
      .filter((line) => line.includes("$STAGING/$EXTRACTED/bin/node"));
    expect(directRuns.length).toBeGreaterThan(0);
    for (const line of directRuns) {
      expect(line).toMatch(/^(if ! )?sudo /);
    }
  });

  it("confere a presença do npm sob sudo", () => {
    expect(code).toMatch(/sudo test -x "\$STAGING\/\$EXTRACTED\/bin\/npm"/);
  });

  it("não abre o staging para outros usuários", () => {
    const chmodOnStaging = code
      .split("\n")
      .filter((line) => /\bchmod\b/.test(line) && /STAGING/.test(line));
    expect(chmodOnStaging).toEqual([]);
    expect(code).not.toMatch(/chmod\s+(-R\s+)?[0-7]*[1-7][0-7]{2}\s+"?\$STAGING/);
  });

  it("mantém a validação final pelo symlink publicável pelo usuário", () => {
    expect(code).toMatch(/INSTALLED_VERSION="\$\("\$CURRENT_LINK\/bin\/node" --version/);
  });

  it("mantém checksum, rename atômico e restauração do symlink", () => {
    expect(code).toMatch(/sha256sum -c -/);
    expect(code).toMatch(/sudo mv -Tf "\$\{ROOT\}\/\.current\.tmp" "\$CURRENT_LINK"/);
    expect(code).toMatch(/PREVIOUS_TARGET="\$\(readlink "\$CURRENT_LINK"/);
  });

  it("limpa o staging numa execução interrompida (reexecução segura)", () => {
    expect(code).toMatch(/sudo rm -rf "\$STAGING" 2>\/dev\/null \|\| true/);
  });

  // Reprodução real: diretório root:root 0700 + binário lá dentro.
  (POSIX_WITH_SUDO ? it : it.skip)(
    "reproduz Permission denied sem sudo e funciona sob sudo",
    () => {
      const staging = execFileSync("sudo", ["-n", "mktemp", "-d"], {
        encoding: "utf-8",
        timeout: 15_000,
      }).trim();

      try {
        const binDir = path.join(staging, "node-v22.23.4-linux-x64", "bin");
        execFileSync(
          "sudo",
          [
            "-n",
            "bash",
            "-c",
            `set -e; mkdir -p '${binDir}'; printf '#!/bin/sh\\necho v22.23.4\\n' > '${binDir}/node'; chmod 0755 '${binDir}/node'`,
          ],
          { stdio: "ignore", timeout: 15_000 },
        );

        // Isolamento preservado: o staging continua 0700 root:root.
        const mode = execFileSync("sudo", ["-n", "stat", "-c", "%a %U:%G", staging], {
          encoding: "utf-8",
          timeout: 15_000,
        }).trim();
        expect(mode).toBe("700 root:root");

        const binary = path.join(binDir, "node");

        // Usuário comum: não atravessa o diretório -> EACCES (o bug original).
        expect(() => execFileSync(binary, ["--version"], { stdio: "pipe" })).toThrow(
          /EACCES|permission denied/i,
        );

        // Mesma validação usada pelo script, sob sudo: resolve.
        const out = execFileSync("sudo", ["-n", binary, "--version"], {
          encoding: "utf-8",
          timeout: 15_000,
        }).trim();
        expect(out).toBe("v22.23.4");
      } finally {
        execFileSync("sudo", ["-n", "rm", "-rf", staging], { stdio: "ignore", timeout: 15_000 });
      }
    },
    30_000,
  );
});
