import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const INSPECT_TIMEOUT_MS = 15_000;
const execFile = promisify(execFileCallback);

/**
 * Executa o `docker inspect` (leitura pura).
 *
 * Nenhum container é criado, reiniciado ou removido - é só leitura do
 * estado real.
 */
async function execDockerInspect(containerName: string): Promise<string> {
  const { stdout } = await execFile("docker", ["inspect", "--format", "{{json .}}", containerName], {
    timeout: INSPECT_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * VERDADE DO DOCKER (somente leitura).
 *
 * O dry-run do deploy precisa mostrar o estado REAL do container de
 * produção - não o que o Core acha que é. Este é um `docker inspect`
 * (leitura pura): nada é criado, reiniciado ou removido.
 */
export interface ContainerTruth {
  id: string | null;
  name: string;
  image: string | null;
  startedAt: string | null;
  restartCount: number | null;
  status: string | null;
  running: boolean;
  health: string | null;
  restartPolicy: string | null;
  memoryLimitBytes: number | null;
  memorySwapBytes: number | null;
  networks: string[];
  ports: string[];
  mounts: { type: string | null; name: string | null; source: string | null; destination: string | null }[];
}

function normalizeNetworks(networks: unknown): string[] {
  if (!networks || typeof networks !== "object") return [];
  return Object.keys(networks as Record<string, unknown>).sort();
}

function normalizePorts(ports: unknown): string[] {
  if (!ports || typeof ports !== "object") return [];
  return Object.keys(ports as Record<string, unknown>).sort();
}

function normalizeMounts(mounts: unknown): ContainerTruth["mounts"] {
  if (!Array.isArray(mounts)) return [];
  return mounts
    .map((mount) => {
      const item = mount as Record<string, unknown>;
      return {
        type: (item.Type as string) ?? null,
        name: (item.Name as string) ?? null,
        source: (item.Source as string) ?? null,
        destination: (item.Destination as string) ?? null,
      };
    })
    .sort((a, b) => String(a.destination).localeCompare(String(b.destination)));
}

/**
 * Assinatura do inspetor de container (injetável para os testes).
 */
export type ContainerInspector = (containerName: string) => Promise<ContainerTruth | null>;

/**
 * Normaliza o payload do `docker inspect` no formato usado pelo dry-run.
 * (Exportado para os testes: o mock do inspetor usa o MESMO parser.)
 */
export function parseContainerInspect(
  parsed: Record<string, unknown>,
  containerName: string,
): ContainerTruth {
  const hostConfig = (parsed.HostConfig ?? {}) as Record<string, unknown>;
  const state = (parsed.State ?? {}) as Record<string, unknown>;
  const config = (parsed.Config ?? {}) as Record<string, unknown>;
  return {
    id: (parsed.Id as string) ?? null,
    name: String(parsed.Name ?? containerName).replace(/^\//, ""),
    image: (config.Image as string) ?? null,
    startedAt: (state.StartedAt as string) ?? null,
    restartCount: typeof parsed.RestartCount === "number" ? (parsed.RestartCount as number) : null,
    status: (state.Status as string) ?? null,
    running: state.Running === true,
    health: ((state.Health as Record<string, unknown>)?.Status as string) ?? null,
    restartPolicy: ((hostConfig.RestartPolicy as Record<string, unknown>)?.Name as string) ?? null,
    memoryLimitBytes: typeof hostConfig.Memory === "number" ? (hostConfig.Memory as number) : null,
    memorySwapBytes:
      typeof hostConfig.MemorySwap === "number" ? (hostConfig.MemorySwap as number) : null,
    networks: normalizeNetworks(
      (parsed.NetworkSettings as Record<string, unknown> | undefined)?.Networks,
    ),
    ports: normalizePorts((parsed.NetworkSettings as Record<string, unknown> | undefined)?.Ports),
    mounts: normalizeMounts(parsed.Mounts),
  };
}

/**
 * Lê o estado real de um container. `null` = o Docker não respondeu (ou o
 * container não existe) - quem chama decide o que fazer (o dry-run falha
 * explicitamente, em vez de inventar estado).
 */
export async function inspectContainerTruth(containerName: string): Promise<ContainerTruth | null> {
  if (!containerName) return null;
  try {
    const stdout = await execDockerInspect(containerName);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return parseContainerInspect(parsed, containerName);
  } catch {
    return null;
  }
}
