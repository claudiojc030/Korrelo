import { spawn } from "node:child_process";

/**
 * Execução de comandos externos (docker, df, git...) com timeout REAL e
 * encerramento garantido do processo.
 *
 * Por que isso existe: no incidente de 19/10/2026 o `docker stats` ficou
 * pendurado porque o `execFile` do Node foi chamado SEM `timeout`. O processo
 * filho nunca morria, a promise nunca resolvia e o cache "in-flight" do
 * dashboard passava a devolver a mesma promise pendurada para TODAS as
 * requisições - o painel inteiro travava atrás do Docker.
 *
 * Regras deste utilitário:
 * - NUNCA usa shell: os argumentos vão direto pro processo (sem interpolação).
 * - Só encerra o PROCESSO CLIENTE (ex.: o binário `docker`), nunca o daemon
 *   nem os containers. Matar o CLI não para o container em execução.
 * - Timeout = SIGTERM e, se o processo não sair, SIGKILL depois de um
 *   intervalo de graça. Sem isso, um CLI travado vira processo órfão.
 * - A saída é limitada: um comando que despeja MB no stdout é interrompido em
 *   vez de estourar a memória do processo da API.
 */
export interface RunCommandOptions {
  /** Tempo máximo de execução. Depois disso o processo é encerrado. */
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Teto de bytes acumulado em stdout+stderr. */
  maxBufferBytes?: number;
  /** Tempo entre o SIGTERM e o SIGKILL quando o processo não coopera. */
  killGraceMs?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** true quando o comando foi encerrado por estourar o timeout. */
  timedOut: boolean;
  /** true quando a saída foi cortada pelo limite de buffer. */
  truncated: boolean;
  durationMs: number;
}

/** Erro de inicialização do processo (ex.: binário inexistente). */
export class CommandSpawnError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CommandSpawnError";
  }
}

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const {
    timeoutMs,
    cwd,
    env,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = options;

  return new Promise<RunCommandResult>((resolve, reject) => {
    const startedAt = Date.now();

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new CommandSpawnError(`Falha ao iniciar "${command}"`, error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    let killTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      killTimer = undefined;
      forceKillTimer = undefined;
    };

    /** Encerra o processo cliente: SIGTERM primeiro, SIGKILL se resistir. */
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // processo já morreu entre a checagem e o kill
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // já encerrado
          }
        }
      }, killGraceMs);
      forceKillTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");

    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf-8");
      if (stdoutBytes > maxBufferBytes) {
        truncated = true;
        stdout = stdout.slice(0, Math.max(0, stdout.length - 1000));
        terminate();
        return;
      }
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf-8");
      if (stderrBytes > maxBufferBytes) {
        truncated = true;
        stderr = stderr.slice(0, Math.max(0, stderr.length - 1000));
        terminate();
        return;
      }
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      clearTimeout(timeoutTimer);
      reject(new CommandSpawnError(`Falha ao executar "${command}": ${error.message}`, error));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      clearTimeout(timeoutTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
