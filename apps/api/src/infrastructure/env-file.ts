import * as fs from "node:fs";

// Atualiza (ou adiciona) chaves num arquivo .env preservando o resto do
// conteúdo (comentários, ordem, variáveis não mencionadas). Usado pra
// persistir credenciais geradas em runtime (ex.: GitHub App via manifest)
// sem exigir edição manual do arquivo.
export function upsertEnvValues(envFilePath: string, values: Record<string, string>): void {
  const original = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf-8") : "";
  const lines = original.length > 0 ? original.split("\n") : [];
  const remainingKeys = new Set(Object.keys(values));

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && remainingKeys.has(match[1])) {
      const key = match[1];
      remainingKeys.delete(key);
      return `${key}="${values[key]}"`;
    }
    return line;
  });

  for (const key of remainingKeys) {
    updatedLines.push(`${key}="${values[key]}"`);
  }

  fs.writeFileSync(envFilePath, updatedLines.join("\n"));
}
