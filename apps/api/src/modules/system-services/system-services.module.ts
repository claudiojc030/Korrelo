import { Module } from "@nestjs/common";
import { SystemServicesController } from "./presentation/system-services.controller";
import { ListSystemServicesUseCase } from "./application/list-system-services.use-case";
import { ToggleSystemServiceUseCase } from "./application/toggle-system-service.use-case";
import { SystemctlServiceController } from "./infrastructure/systemctl-service-controller";
import { OS_SERVICE_CONTROLLER } from "./domain/os-service-controller";

@Module({
  controllers: [SystemServicesController],
  providers: [
    ListSystemServicesUseCase,
    ToggleSystemServiceUseCase,
    { provide: OS_SERVICE_CONTROLLER, useClass: SystemctlServiceController },
  ],
})
export class SystemServicesModule {}
