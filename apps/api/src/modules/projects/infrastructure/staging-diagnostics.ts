import { Injectable } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeSelfUpdateLog } from "../../monitoring/infrastructure/self-update-log-sanitizer";
import { DockerLogReader } from "./docker-log-reader";

const execFile = promisify(execFileCallback);
const INSPECT_TIMEOUT_MS = 15_000;

/** Quantas linhas de log do staging são preservadas (e nada além). */
export const STAGING_DIAGNOSTICS_TAIL_LINES = 200;

/**
 * DIAGNÓSTICO DO STAGING ANTES DO CLEANUP.
 *
 * Quando o health do container de teste falha, o `finally` do deploy remove
 * o container. Sem capturar nada antes, o operador fica só com "não
 * respondeu em Ns" - e não dá pra distinguir OOM, app que saiu (ex.: Mongo
 * indisponível no boot) de processo vivo mas sem escutar.
 *
 * Esta captura é SOMENTE OBSERVABILIDADE:
 * - best-effort: qualquer falha vira uma linha "diagnóstico parcial";
 * - NUNCA altera a causa original do deploy nem impede o cleanup;
 * - lê apenas campos escalares do inspect (State.Status/ExitCode/OOMKilled,
 *   RestartCount, StartedAt/FinishedAt) e HostConfig.Memory;
 * - NUNCA lê Config.Env, mounts, labels sensíveis, command line ou o
 *   inspect completo;
 * - logs passam por sanitização ANTES de sair daqui.
 */

/** Campos seguros do container de staging (sem env, sem segredo). */
export interface StagingContainerState {
  containerName: string;
  status: string | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  restartCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  memoryLimitMb: number | null;
}

export interface StagingDiagnosticsCapture {
  containerName: string;
  state: StagingContainerState | null;
  /** Já sanitizado. null = não foi possível ler. */
  logs: string | null;
  /** Motivos (sanitizados) de captura parcial - nunca conteúdo bruto. */
  errors: string[];
}

/** Dependências injetáveis (os testes não chamam Docker de verdade). */
export interface StagingDiagnosticsRuntime {
  inspectState(containerName: string): Promise<StagingContainerState | null>;
  readLogs(containerName: string, tailLines: number): Promise<string>;
}

export interface StagingDiagnosticsCollectorLike {
  collect(containerName: string): Promise<StagingDiagnosticsCapture>;
}

/** Token/chave longa (32+). SHA de commit (40 hex) é preservado: não é segredo. */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
/** Credencial em URL de QUALQUER esquema (`scheme://user:pass@host`). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s"'/@]+@/gi;

/**
 * Sanitização dos textos de diagnóstico.
 *
 * Reutiliza o sanitizador existente (connection strings, Bearer, PEM,
 * `SENHA=...`, valores de env sensíveis) e acrescenta duas regras
 * conservadoras: credencial em URL de esquema desconhecido e token longo.
 */
export function sanitizeDiagnosticText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = sanitizeSelfUpdateLog(String(text ?? ""), env);
  output = output.replace(URL_CREDENTIALS, "$1***@");
  output = output.replace(LONG_TOKEN, (token) =>
    /^[0-9a-f]{40}$/i.test(token) ? token : "***",
  );
  return output;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Só a primeira linha: stack trace não ajuda no diagnóstico do container.
  return sanitizeDiagnosticText(message.split("\n")[0].slice(0, 300));
}

const logReader = new DockerLogReader();

/** Implementação real (somente leitura). */
export const defaultStagingDiagnosticsRuntime: StagingDiagnosticsRuntime = {
  async inspectState(containerName: string): Promise<StagingContainerState | null> {
    const { stdout } = await execFile(
      "docker",
      ["inspect", "--format", "{{json .}}", containerName],
      { timeout: INSPECT_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      Name?: string;
      RestartCount?: number;
      State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean; StartedAt?: string; FinishedAt?: string };
      HostConfig?: { Memory?: number };
    };
    const state = parsed.State ?? {};
    const memoryBytes = parsed.HostConfig?.Memory ?? 0;
    return {
      containerName: (parsed.Name ?? containerName).replace(/^\//, ""),
      status: state.Status ?? null,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      oomKilled: typeof state.OOMKilled === "boolean" ? state.OOMKilled : null,
      restartCount: typeof parsed.RestartCount === "number" ? parsed.RestartCount : null,
      startedAt: state.StartedAt ?? null,
      finishedAt: state.FinishedAt ?? null,
      memoryLimitMb: memoryBytes > 0 ? Math.round(memoryBytes / 1024 / 1024) : null,
    };
  },
  async readLogs(containerName: string, tailLines: number): Promise<string> {
    return logReader.readLogs(containerName, tailLines);
  },
};

@Injectable()
export class StagingDiagnosticsCollector implements StagingDiagnosticsCollectorLike {
  constructor(
    private readonly runtime: StagingDiagnosticsRuntime = defaultStagingDiagnosticsRuntime,
  ) {}

  /**
   * Coleta best-effort. NÃO lança: cada falha vira uma entrada em `errors`.
   * O container de PRODUÇÃO nunca é consultado - quem chama passa apenas o
   * nome do container de staging.
   */
  async collect(containerName: string): Promise<StagingDiagnosticsCapture> {
    const errors: string[] = [];
    let state: StagingContainerState | null = null;
    let logs: string | null = null;

    try {
      state = await this.runtime.inspectState(containerName);
    } catch (error) {
      errors.push(`inspect: ${shortError(error)}`);
    }

    try {
      logs = sanitizeDiagnosticText(
        await this.runtime.readLogs(containerName, STAGING_DIAGNOSTICS_TAIL_LINES),
      );
    } catch (error) {
      errors.push(`logs: ${shortError(error)}`);
    }

    return { containerName, state, logs, errors };
  }
}

/** Bloco de texto que vai para o histórico do deploy. */
export function formatStagingDiagnostics(capture: StagingDiagnosticsCapture): string {
  const lines = ["--- diagnóstico do staging (antes do cleanup) ---"];
  lines.push(`container: ${capture.containerName}`);

  if (capture.state) {
    const s = capture.state;
    lines.push(
      `status: ${s.status ?? "?"} | exitCode: ${s.exitCode ?? "?"} | oomKilled: ${s.oomKilled ?? "?"} | restarts: ${s.restartCount ?? "?"}`,
    );
    lines.push(`startedAt: ${s.startedAt ?? "?"} | finishedAt: ${s.finishedAt ?? "?"}`);
    lines.push(`memoryLimitMb: ${s.memoryLimitMb ?? "?"}`);
  } else {
    lines.push("estado: indisponível");
  }

  if (capture.logs !== null) {
    lines.push(`--- últimos ${STAGING_DIAGNOSTICS_TAIL_LINES} logs (sanitizados) ---`);
    lines.push(capture.logs.trim() || "(vazio)");
  } else {
    lines.push("logs: indisponíveis");
  }

  if (capture.errors.length > 0) {
    lines.push(`diagnóstico parcial: ${capture.errors.join("; ")}`);
  }

  return `${lines.join("\n")}\n`;
}
