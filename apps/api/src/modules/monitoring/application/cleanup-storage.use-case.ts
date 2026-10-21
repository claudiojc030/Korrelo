/**
 * LIMPEZA DE ARMAZENAMENTO (allowlist fechada + log).
 *
 * Regras de segurança (não negociáveis):
 *  1. o frontend NUNCA envia um comando nem um path: só o ID de uma ação
 *     da allowlist (StorageActionId). O backend constrói o comando;
 *  2. uma ação fora da allowlist é REJEITADA (não executa nada);
 *  3. o dry-run (plan) NUNCA remove nada;
 *  4. as proteções (imagens current/previous/candidata, volumes, backup
 *     mais recente, job ativo) são verificadas ANTES de executar;
 *  5. tudo o que roda é registrado num log de auditoria (sem segredo).
 */

import { Injectable, Logger, Optional } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STORAGE_ACTIONS,
  type StorageActionId,
  type StorageCleanupLogEntry,
  type StorageCleanupResult,
  type StorageItem,
  type StorageOverview,
} from "../domain/storage-audit";
import {
  StorageAuditService,
  defaultCommandRunner,
  type CommandRunner,
} from "../infrastructure/storage-audit.service";

/** Runner padrão da limpeza: o command-runner real do Core. */
const cleanupCommandRunner: CommandRunner = (command, args, options) =>
  defaultCommandRunner(command, args, { timeoutMs: options?.timeoutMs ?? 60_000 });

/** Ações que removem arquivos/diretórios (precisam de path resolvido aqui). */
const FILE_CLEANUP_ACTIONS: StorageActionId[] = [
  "self-update-old-logs",
  "korrelo-old-artifact-backups",
  "korrelo-old-backups",
  "temp-korrelo",
];

/**
 * Tolerância (bytes) entre o espaço medido no disco e o que as ações
 * reportaram. Acima disso, o painel assume que houve OUTRA atividade no
 * host durante a limpeza e mostra os dois números - sem fabricar
 * reconciliação.
 */
const DIVERGENCE_TOLERANCE_BYTES = 64 * 1024 * 1024;

@Injectable()
export class CleanupStorageUseCase {
  private readonly logger = new Logger(CleanupStorageUseCase.name);
  /**
   * Trava de concorrência: duas limpezas simultâneas brigariam pelo mesmo
   * cache/volume. A segunda é RECUSADA (não é enfileirada): limpar
   * enquanto outra limpeza roda é exatamente o tipo de coisa que a
   * allowlist existe para impedir.
   */
  private cleaning = false;

  constructor(
    private readonly audit: StorageAuditService,
    // O runner é opcional (o Nest não injeta funções) - nos testes é
    // injetado um fake.
    @Optional() private readonly runCommand: CommandRunner = cleanupCommandRunner,
    // Operação crítica em andamento (self-update/deploy): a limpeza é
    // recusada - mexer no disco no meio de um build/update é risco.
    @Optional() private readonly selfUpdater?: { getStatus: () => Promise<{ running: boolean }> },
    @Optional() private readonly deployQueue?: { hasActiveJob: () => Promise<boolean> },
  ) {}

  private get stateDir(): string {
    return process.env.KORRELO_STATE_DIR ?? path.join(os.homedir(), ".korrelo");
  }

  private get cleanupLogPath(): string {
    return path.join(this.stateDir, "storage-cleanup.log");
  }

  /** Dry-run: devolve o que SERIA feito. NÃO remove nada. */
  async plan(): Promise<{
    overview: StorageOverview;
    actions: {
      id: StorageActionId;
      label: string;
      command: string;
      items: StorageItem[];
      bytes: number;
    }[];
  }> {
    const overview = await this.audit.audit();
    const byAction = new Map<StorageActionId, StorageItem[]>();
    for (const item of overview.items) {
      if (item.classification !== "SAFE_TO_CLEAN") continue;
      if (!item.proposedAction) continue;
      const list = byAction.get(item.proposedAction) ?? [];
      list.push(item);
      byAction.set(item.proposedAction, list);
    }

    const actions = Array.from(byAction.entries()).map(([id, items]) => ({
      id,
      label: STORAGE_ACTIONS[id].label,
      command: STORAGE_ACTIONS[id].command,
      items,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    }));

    return { overview, actions };
  }

  /**
   * Executa as ações pedidas (allowlist fechada).
   *
   * `requested` só pode conter IDs da allowlist - qualquer outro valor é
   * recusado e NADA é executado.
   */
  async clean(requested: StorageActionId[], operator: string): Promise<{
    results: StorageCleanupResult[];
    bytesFreed: number;
    logEntry: StorageCleanupLogEntry;
  }> {
    const invalidos = requested.filter((id) => !(id in STORAGE_ACTIONS));
    if (invalidos.length > 0) {
      // NADA é executado: a allowlist é fechada.
      throw new Error(
        `Ação de limpeza desconhecida (recusada): ${invalidos.join(", ")}. ` +
          "Só ações da allowlist do Korrelo podem ser executadas.",
      );
    }

    // Trava de concorrência: uma segunda limpeza é RECUSADA.
    if (this.cleaning) {
      throw new Error("Já existe uma limpeza em andamento. Aguarde ela terminar.");
    }
    // A trava é ligada ANTES de qualquer await: senão duas chamadas
    // simultâneas passariam pelas duas verificações.
    this.cleaning = true;

    try {
      // Operação crítica em andamento: a limpeza é recusada (não é o momento).
      if (await this.hasCriticalOperationInFlight()) {
        throw new Error(
          "Há uma operação crítica em andamento (atualização do Korrelo ou deploy de projeto). " +
            "A limpeza foi recusada - tente de novo quando terminar.",
        );
      }

      const before = await this.audit.audit();
      const results: StorageCleanupResult[] = [];
      const failures: string[] = [];

      for (const id of requested) {
        const result = await this.executeAction(id);
        results.push(result);
        if (result.error) failures.push(`${id}: ${result.error}`);
      }

      const after = await this.audit.audit();

      // ANTES x DEPOIS: o MESMO filesystem (/) e a MESMA fonte (df), em
      // bytes, sem arredondar antes do cálculo.
      //
      // O bug antigo misturava bases: o painel mostrava "livre antes" (df)
      // ao lado de "usado depois" (df) - daí "20 GB -> 26 GB" com 723 MB
      // recuperados, números que não tinham relação entre si.
      const freeBeforeBytes = before.freeBytes;
      const freeAfterBytes = after.freeBytes;
      const bytesFreed = Math.max(0, freeAfterBytes - freeBeforeBytes);

      // O que as ações reportaram ter removido. Só serve de comparação se
      // alguma ação consegue medir (as de comando não sabem).
      const reported = results
        .map((result) => result.bytesFreed)
        .filter((value) => value > 0);
      const reportedBytesFreed = reported.length > 0 ? reported.reduce((a, b) => a + b, 0) : null;
      const measurementDiverged =
        reportedBytesFreed !== null &&
        Math.abs(bytesFreed - reportedBytesFreed) > DIVERGENCE_TOLERANCE_BYTES;

      const logEntry: StorageCleanupLogEntry = {
        at: new Date().toISOString(),
        operator,
        action: requested.length === 1 ? requested[0] : null,
        requested,
        items: results.length,
        freeBeforeBytes,
        freeAfterBytes,
        bytesFreed,
        reportedBytesFreed,
        measurementDiverged,
        failures,
      };
      this.appendLog(logEntry);

      return { results, bytesFreed, logEntry };
    } finally {
      this.cleaning = false;
    }
  }

  /** true quando há self-update ou deploy de projeto em andamento. */
  private async hasCriticalOperationInFlight(): Promise<boolean> {
    try {
      if (this.selfUpdater) {
        const status = await this.selfUpdater.getStatus();
        if (status?.running) return true;
      }
    } catch {
      /* sem informação: não bloqueia */
    }
    try {
      if (this.deployQueue && (await this.deployQueue.hasActiveJob())) return true;
    } catch {
      /* sem informação: não bloqueia */
    }
    return false;
  }

  /** Executa UMA ação da allowlist (e SÓ se ela tiver itens SAFE). */
  private async executeAction(id: StorageActionId): Promise<StorageCleanupResult> {
    const definition = STORAGE_ACTIONS[id];
    const executedAt = new Date().toISOString();

    try {
      if (FILE_CLEANUP_ACTIONS.includes(id)) {
        const freed = await this.cleanFiles(id);
        return {
          action: id,
          executedAt,
          bytesFreed: freed,
          output: `removidos ${freed} bytes`,
          error: null,
          executed: true,
        };
      }

      // Só executa se a auditoria (agora, neste momento) classificou
      // algum item como SAFE_TO_CLEAN para esta ação. Uma ação REVIEW
      // (ex.: imagem commit antiga) NUNCA é executada automaticamente.
      const plan = await this.plan();
      const alvo = plan.actions.find((entry) => entry.id === id);
      if (!alvo || alvo.items.length === 0) {
        return {
          action: id,
          executedAt,
          bytesFreed: 0,
          output: null,
          error: "nenhum item seguro para esta ação (nada foi executado)",
          executed: false,
        };
      }

      const result = await this.runCommand("/bin/sh", ["-c", definition.command], {
        timeoutMs: 120_000,
      });
      const error = result.exitCode === 0 ? null : `exit code ${result.exitCode}`;
      return {
        action: id,
        executedAt,
        bytesFreed: 0,
        output: (result.stdout || result.stderr || "").trim().slice(0, 2000) || null,
        error,
        executed: result.exitCode === 0,
      };
    } catch (error) {
      return {
        action: id,
        executedAt,
        bytesFreed: 0,
        output: null,
        error: String((error as Error)?.message ?? error),
        executed: false,
      };
    }
  }

  /**
   * Limpeza de ARQUIVOS: só remove o que a auditoria classificou como
   * SAFE_TO_CLEAN, dentro dos diretórios conhecidos do Korrelo.
   *
   * Nenhum path vem do frontend: os diretórios são resolvidos AQUI.
   */
  private async cleanFiles(action: StorageActionId): Promise<number> {
    const plan = await this.plan();
    const alvo = plan.actions.find((entry) => entry.id === action);
    if (!alvo) return 0;

    let freed = 0;
    for (const item of alvo.items) {
      const target = item.detail;
      if (!target) continue;
      // Só remove dentro de um diretório conhecido do Korrelo (allowlist de
      // caminhos) - nunca um path arbitrário.
      if (!this.isAllowedCleanupPath(target)) continue;
      try {
        const stat = fs.statSync(target);
        const size = stat.isDirectory() ? 0 : stat.size;
        fs.rmSync(target, { recursive: true, force: true });
        freed += size;
      } catch {
        /* já removido ou sem permissão */
      }
    }
    return freed;
  }

  /** Caminhos que o Korrelo pode remover (allowlist de diretórios). */
  private isAllowedCleanupPath(target: string): boolean {
    const home = os.homedir();
    const allowedRoots = [
      path.join(this.stateDir, "self-update"),
      path.join(home, "korrelo-backups"),
      path.join(home, "korrelo-artifact-backups"),
      "/tmp",
      "/var/tmp",
    ];
    const resolved = path.resolve(target);
    return allowedRoots.some((root) => {
      const rootResolved = path.resolve(root);
      return resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`);
    });
  }

  /** Log de auditoria da limpeza (append-only, sem segredo). */
  private appendLog(entry: StorageCleanupLogEntry): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.appendFileSync(this.cleanupLogPath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      this.logger.warn(`[storage] não foi possível escrever o log de limpeza: ${error}`);
    }
  }
}
