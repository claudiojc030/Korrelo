// Parseia o conteúdo colado de um .env (CHAVE=valor, uma por linha) igual o
// upsertEnvValues do backend escreve. Comentários e linhas em branco são
// ignorados; valor entre aspas simples/duplas é destrinchado.
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(pattern);
    if (!match) continue;

    let value = match[2];
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    values[match[1]] = value;
  }

  return values;
}
