import { headers } from "next/headers";

// "localhost" só funciona quando quem acessa o Korrelo está na mesma máquina
// da VPS. Como o painel normalmente é acessado remotamente (IP ou domínio da
// VPS), os links de "abrir projeto" precisam usar o mesmo host que o
// navegador usou pra chegar no Korrelo, não a palavra literal "localhost".
// O header Host reflete exatamente isso.
export async function getRequestHostServer(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  return host.split(":")[0];
}
