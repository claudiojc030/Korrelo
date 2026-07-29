import { Injectable, InternalServerErrorException } from "@nestjs/common";
import * as net from "node:net";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_ATTEMPTS = 30;
const CONNECT_TIMEOUT_MS = 300;

// Tenta CONECTAR na porta em vez de só tentar abri-la (bind). Um bind test sozinho
// não é confiável em todo SO: no Windows, por exemplo, é permitido religar na mesma
// porta já usada por outro processo do mesmo usuário, o que mascarava conflitos reais
// (inclusive com a própria porta da API). Connect é o teste que realmente importa,
// pois se algo responde, a porta está ocupada, em qualquer sistema operacional.
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function getDockerPublishedPorts(): Promise<Set<number>> {
  try {
    const { stdout } = await execFile("docker", ["ps", "--format", "{{.Ports}}"]);
    const ports = new Set<number>();
    // Ex.: "0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp"
    for (const match of stdout.matchAll(/:(\d+)->/g)) {
      ports.add(Number(match[1]));
    }
    return ports;
  } catch {
    // Se o docker não responder, segue só com os outros testes. Não trava o allocator por isso.
    return new Set();
  }
}

@Injectable()
export class PortAllocator {
  async allocate(preferredPort: number): Promise<number> {
    const dockerPorts = await getDockerPublishedPorts();

    for (let offset = 0; offset < MAX_ATTEMPTS; offset++) {
      const candidate = preferredPort + offset;
      if (dockerPorts.has(candidate)) continue;
      if (await isPortInUse(candidate)) continue;
      if (await isPortBindable(candidate)) {
        return candidate;
      }
    }
    throw new InternalServerErrorException(
      `Nenhuma porta livre encontrada a partir de ${preferredPort} (${MAX_ATTEMPTS} tentativas).`,
    );
  }
}
