import { Body, Controller, Delete, Get, HttpCode, Put, Post } from "@nestjs/common";
import { GetCoreDomainUseCase } from "../application/get-core-domain.use-case";
import { AttachCoreDomainUseCase } from "../application/attach-core-domain.use-case";
import { DetachCoreDomainUseCase } from "../application/detach-core-domain.use-case";
import { ListCoreEnvUseCase } from "../application/list-core-env.use-case";
import { SetCoreEnvVarUseCase } from "../application/set-core-env-var.use-case";
import { SetCoreEnvBulkUseCase } from "../application/set-core-env-bulk.use-case";
import { AttachCoreDomainDto } from "./attach-core-domain.dto";
import { SetCoreEnvVarDto } from "./set-core-env-var.dto";
import { SetCoreEnvBulkDto } from "./set-core-env-bulk.dto";

@Controller("settings")
export class SettingsController {
  constructor(
    private readonly getCoreDomain: GetCoreDomainUseCase,
    private readonly attachCoreDomain: AttachCoreDomainUseCase,
    private readonly detachCoreDomain: DetachCoreDomainUseCase,
    private readonly listCoreEnv: ListCoreEnvUseCase,
    private readonly setCoreEnvVar: SetCoreEnvVarUseCase,
    private readonly setCoreEnvBulk: SetCoreEnvBulkUseCase,
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

  @Get("env")
  env() {
    return this.listCoreEnv.execute();
  }

  @Put("env")
  async setEnvVarEndpoint(@Body() dto: SetCoreEnvVarDto) {
    await this.setCoreEnvVar.execute(dto.key, dto.value);
    return { ok: true };
  }

  @Put("env/bulk")
  setEnvBulkEndpoint(@Body() dto: SetCoreEnvBulkDto) {
    return this.setCoreEnvBulk.execute(dto.text);
  }
}
