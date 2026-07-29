import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { apiError } from "../../../infrastructure/api-error";
import { findServiceDefinition } from "../domain/service-catalog";
import { OS_SERVICE_CONTROLLER, type OsServiceController } from "../domain/os-service-controller";

@Injectable()
export class ToggleSystemServiceUseCase {
  constructor(@Inject(OS_SERVICE_CONTROLLER) private readonly controller: OsServiceController) {}

  async execute(serviceId: string, enabled: boolean): Promise<void> {
    // Só aceita IDs do catálogo fechado, nunca um nome de unit vindo direto
    // do cliente, pra não virar um jeito de ligar/desligar QUALQUER serviço.
    const service = findServiceDefinition(serviceId);
    if (!service) {
      throw new BadRequestException(apiError("SERVICE_UNKNOWN", `Serviço desconhecido: "${serviceId}".`));
    }

    const state = await this.controller.getState(service.unitName);
    if (!state.exists) {
      throw new BadRequestException(apiError("SERVICE_NOT_FOUND_ON_VPS", `O serviço "${service.displayName}" não existe nesta VPS.`));
    }

    await this.controller.setEnabled(service.unitName, enabled);
  }
}
