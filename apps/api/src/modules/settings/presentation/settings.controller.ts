import { Body, Controller, Delete, Get, HttpCode, Put, Post, Req, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { apiError } from "../../../infrastructure/api-error";
import { GetCoreDomainUseCase } from "../application/get-core-domain.use-case";
import { AttachCoreDomainUseCase } from "../application/attach-core-domain.use-case";
import { DetachCoreDomainUseCase } from "../application/detach-core-domain.use-case";
import { ListCoreEnvUseCase } from "../application/list-core-env.use-case";
import { SetCoreEnvVarUseCase } from "../application/set-core-env-var.use-case";
import { SetCoreEnvBulkUseCase } from "../application/set-core-env-bulk.use-case";
import { RevealCoreEnvVarUseCase } from "../application/reveal-core-env-var.use-case";
import { AttachCoreDomainDto } from "./attach-core-domain.dto";
import { SetCoreEnvVarDto } from "./set-core-env-var.dto";
import { SetCoreEnvBulkDto } from "./set-core-env-bulk.dto";
import { RevealCoreEnvVarDto } from "./reveal-core-env-var.dto";

/**
 * Limite próprio pra revelação de segredo: são poucas tentativas legítimas
 * (o admin revelando uma variável por vez), então o teto é bem mais apertado
 * que o global (120/min) e o mesmo das tentativas de login.
 */
const REVEAL_ATTEMPT_LIMIT = { default: { ttl: 60_000, limit: 5 } };

@Controller("settings")
export class SettingsController {
  constructor(
    private readonly getCoreDomain: GetCoreDomainUseCase,
    private readonly attachCoreDomain: AttachCoreDomainUseCase,
    private readonly detachCoreDomain: DetachCoreDomainUseCase,
    private readonly listCoreEnv: ListCoreEnvUseCase,
    private readonly setCoreEnvVar: SetCoreEnvVarUseCase,
    private readonly setCoreEnvBulk: SetCoreEnvBulkUseCase,
    private readonly revealCoreEnvVar: RevealCoreEnvVarUseCase,
  ) {}

  @Get("domain")
  domain() {
    return this.getCoreDomain.execute();
  }

  @Post("domain")
  attachDomainEndpoint(@Body() dto: AttachCoreDomainDto) {
    return this.attachCoreDomain.execute(dto.domain);
  }

  @Delete("domain")
  @HttpCode(204)
  async detachDomainEndpoint() {
    await this.detachCoreDomain.execute();
  }

  /**
   * Lista as variáveis do Core. Valores sensíveis vêm MASCARADOS - o valor
   * real só sai pela rota de revelação, que exige a senha do administrador.
   */
  @Get("env")
  env() {
    return this.listCoreEnv.execute();
  }

  @Put("env")
  async setEnvVarEndpoint(@Body() dto: SetCoreEnvVarDto) {
    const result = await this.setCoreEnvVar.execute(dto.key, dto.value);
    return { ok: true, ...result };
  }

  @Put("env/bulk")
  async setEnvBulkEndpoint(@Body() dto: SetCoreEnvBulkDto) {
    return this.setCoreEnvBulk.execute(dto.text);
  }

  /**
   * Revela o valor real de UMA variável, exigindo a senha do administrador.
   * Rota nova: o comportamento de "ver segredo" deixa de ser implícito (via
   * listagem) e passa a ser explícito e auditado.
   */
  @Post("env/reveal")
  @Throttle(REVEAL_ATTEMPT_LIMIT)
  async revealEnvVarEndpoint(@Body() dto: RevealCoreEnvVarDto, @Req() req: Request) {
    const userId = (req as Request & { user?: { sub?: string } }).user?.sub;
    if (!userId) {
      throw new UnauthorizedException(apiError("SESSION_EXPIRED", "Sessão expirada. Faça login novamente."));
    }
    return this.revealCoreEnvVar.execute(userId, dto.key, dto.password);
  }
}
