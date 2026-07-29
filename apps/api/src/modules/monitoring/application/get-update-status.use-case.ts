import { Inject, Injectable } from "@nestjs/common";
import { UPDATE_CHECKER, type UpdateChecker, type UpdateStatus } from "../domain/update-checker";

// Checar atualização exige um `git fetch` de verdade (rede) — não faz
// sentido repetir isso a cada poll do dashboard. Cache de 10 minutos com
// dedupe do in-flight (mesmo padrão do GetSystemMetricsUseCase).
const CACHE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class GetUpdateStatusUseCase {
  private cached: { value: UpdateStatus; expiresAt: number } | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(@Inject(UPDATE_CHECKER) private readonly checker: UpdateChecker) {}

  async execute(): Promise<UpdateStatus> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.checker.check();
    try {
      const value = await this.inFlight;
      this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    } finally {
      this.inFlight = null;
    }
  }
}
