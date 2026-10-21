import { Inject, Injectable } from "@nestjs/common";
import { UPDATE_CHECKER, type UpdateChecker, type UpdateStatus } from "../domain/update-checker";

// Checar atualização exige um `git fetch` de verdade (rede), e não faz
// sentido repetir isso a cada poll do dashboard. Cache CURTO (2 min) com
// dedupe do in-flight (mesmo padrão do GetSystemMetricsUseCase).
//
// O cache é invalidado quando o COMMIT LOCAL muda: é o que acontece logo
// depois de um self-update (o HEAD avança). Sem essa invalidação, o
// dashboard continuava mostrando "atualização disponível" mesmo com
// `git log HEAD..origin/main` vazio - o bug do banner falso.
const CACHE_TTL_MS = 2 * 60 * 1000;

interface CachedUpdateStatus {
  value: UpdateStatus;
  expiresAt: number;
  /** Commit local quando o cache foi feito (para detectar mudança de HEAD). */
  localCommit: string | null;
}

@Injectable()
export class GetUpdateStatusUseCase {
  private cached: CachedUpdateStatus | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(@Inject(UPDATE_CHECKER) private readonly checker: UpdateChecker) {}

  async execute(): Promise<UpdateStatus> {
    const localCommit = await this.readLocalCommit();

    // Cache válido E o HEAD não mudou: devolve o que tem.
    if (
      this.cached &&
      this.cached.expiresAt > Date.now() &&
      this.cached.localCommit === localCommit
    ) {
      return this.cached.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.checker.check();
    try {
      const value = await this.inFlight;
      this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS, localCommit };
      return value;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Invalida o cache (usado quando um self-update termina: o HEAD muda e
   * a checagem precisa ser refeita).
   */
  invalidate(): void {
    this.cached = null;
  }

  /** Commit local (null se o checker não sabe ou deu erro). */
  private async readLocalCommit(): Promise<string | null> {
    if (typeof this.checker.localCommit !== "function") return null;
    try {
      return await this.checker.localCommit();
    } catch {
      return null;
    }
  }
}
