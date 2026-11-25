/**
 * LEITURA SEGURA DO PICO DE MEMÓRIA DO CGROUP.
 *
 * Fonte: `memory.peak` (cgroup v2, kernel 5.19+) ou
 * `memory.max_usage_in_bytes` (cgroup v1).
 *
 * O valor é lido do HOST, a partir do PID init do container e do caminho
 * informado pelo próprio kernel em `/proc/<pid>/cgroup`. Nenhum caminho ou PID
 * vem do usuário. O caminho é validado e precisa conter o container ID
 * completo, o que impede que um container seja associado ao cgroup de outro.
 *
 * Qualquer falha (arquivo ausente, permissão, PID morto, formato inválido,
 * timeout) retorna null. O coletor principal nunca falha por causa disso.
 */

import { readFile, realpath } from "node:fs/promises";
import { posix } from "node:path";

export interface CgroupMemoryMapping {
  version: 1 | 2;
  /** Caminho do cgroup dentro do controlador (sempre absoluto). */
  path: string;
}

export interface ContainerCgroupTarget {
  pid: number | null;
  containerId: string | null;
}

export interface CgroupPeakReadOptions {
  /** Injetável nos testes. Deve ler texto ou rejeitar. */
  readTextFile?: (filePath: string) => Promise<string>;
  /** Injetável nos testes. Resolve symlinks; padrão: fs.realpath. */
  resolveRealPath?: (filePath: string) => Promise<string>;
  /** Limite total para cada leitura. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;
const MAX_CGROUP_PATH_LENGTH = 4096;
const MAX_PID = 2_147_483_647;
const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/i;

/** Interpreta `/proc/<pid>/cgroup` sem presumir v1 ou v2. */
export function parseCgroupMemoryMapping(raw: string): CgroupMemoryMapping | null {
  if (!raw) return null;
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

  // cgroup v2: "0::/system.slice/docker-<id>.scope"
  const unified = lines.find((line) => line.startsWith("0::"));
  if (unified) {
    const path = unified.slice(3);
    return validMapping(2, path);
  }

  // cgroup v1: "11:memory:/docker/<id>" (controllers podem ser lista)
  for (const line of lines) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line);
    if (!match) continue;
    const controllers = match[1].split(",").map((value) => value.trim());
    if (!controllers.includes("memory")) continue;
    return validMapping(1, match[2]);
  }
  return null;
}

function validMapping(version: 1 | 2, path: string): CgroupMemoryMapping | null {
  if (!isSafeCgroupPath(path)) return null;
  return { version, path };
}

function isSafeCgroupPath(path: string): boolean {
  if (!path.startsWith("/") || path.length > MAX_CGROUP_PATH_LENGTH) return false;
  if (/[\u0000\r\n]/.test(path)) return false;
  const segments = path.split("/").filter(Boolean);
  return !segments.includes("..") && !segments.includes(".");
}

function isValidPid(pid: number | null): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function isValidContainerId(containerId: string | null): containerId is string {
  return typeof containerId === "string" && CONTAINER_ID_RE.test(containerId);
}

/** Caminho absoluto do arquivo de pico, ou null se a associação não for segura. */
export function cgroupPeakFilePath(
  mapping: CgroupMemoryMapping,
  containerId: string | null,
): string | null {
  if (!isValidContainerId(containerId)) return null;
  if (!mapping.path.includes(containerId)) return null;

  const root = cgroupRoot(mapping.version);
  const relative = mapping.path.replace(/^\/+/, "");
  const file = posix.join(root, relative, mapping.version === 2 ? "memory.peak" : "memory.max_usage_in_bytes");
  if (!isInsideRoot(file, root)) return null;
  return file;
}

function cgroupRoot(version: 1 | 2): string {
  return version === 2 ? "/sys/fs/cgroup" : "/sys/fs/cgroup/memory";
}

function isInsideRoot(filePath: string, root: string): boolean {
  return filePath !== root && filePath.startsWith(`${root}/`);
}

/** Converte bytes do cgroup em MB; valores inválidos viram null. */
export function parseCgroupPeakBytes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return Math.ceil(bytes / 1024 / 1024);
}

/**
 * Lê o pico real do cgroup para UM container.
 *
 * - PID e container ID vêm de uma inspeção do Docker já validada pelo chamador;
 * - o caminho vem de `/proc/<pid>/cgroup`, não do usuário;
 * - o caminho precisa conter o container ID completo;
 * - timeout, permissão, arquivo ausente ou valor inválido => null.
 */
export async function readContainerCgroupPeakMb(
  target: ContainerCgroupTarget,
  options: CgroupPeakReadOptions = {},
): Promise<number | null> {
  if (!isValidPid(target.pid) || !isValidContainerId(target.containerId)) return null;
  const read = options.readTextFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  const resolveRealPath = options.resolveRealPath ?? ((filePath: string) => realpath(filePath));
  const timeoutMs = positiveTimeout(options.timeoutMs);

  const cgroupRaw = await readWithTimeout(read, `/proc/${target.pid}/cgroup`, timeoutMs);
  if (cgroupRaw === null) return null;

  const mapping = parseCgroupMemoryMapping(cgroupRaw);
  if (!mapping) return null;

  const file = cgroupPeakFilePath(mapping, target.containerId);
  if (!file) return null;

  const realFile = await readWithTimeout(resolveRealPath, file, timeoutMs);
  if (
    realFile === null ||
    !isInsideRoot(realFile, cgroupRoot(mapping.version)) ||
    !realFile.includes(target.containerId)
  ) {
    return null;
  }

  const rawPeak = await readWithTimeout(read, realFile, timeoutMs);
  if (rawPeak === null) return null;

  return parseCgroupPeakBytes(rawPeak);
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS;
}

async function readWithTimeout(
  read: (filePath: string) => Promise<string>,
  filePath: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read(filePath), timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
