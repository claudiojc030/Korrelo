import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ListSystemServicesUseCase } from "../application/list-system-services.use-case";
import { ToggleSystemServiceUseCase } from "../application/toggle-system-service.use-case";
import { ToggleServiceDto } from "./toggle-service.dto";

@Controller("system-services")
export class SystemServicesController {
  constructor(
    private readonly listServices: ListSystemServicesUseCase,
    private readonly toggleService: ToggleSystemServiceUseCase,
  ) {}

  @Get()
  list() {
    return this.listServices.execute();
  }

  @Post(":id/toggle")
  async toggle(@Param("id") id: string, @Body() dto: ToggleServiceDto) {
    await this.toggleService.execute(id, dto.enabled);
    return { ok: true };
  }
}
