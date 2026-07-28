import { Inject, Injectable } from "@nestjs/common";
import { SERVICE_CATALOG } from "../domain/service-catalog";
import { OS_SERVICE_CONTROLLER, type OsServiceController } from "../domain/os-service-controller";

export interface SystemServiceView {
  id: string;
  displayName: string;
  category: string;
  description: string;
  riskLevel: string;
  riskNote: string;
  exists: boolean;
  active: boolean;
  enabled: boolean;
}

@Injectable()
export class ListSystemServicesUseCase {
  constructor(@Inject(OS_SERVICE_CONTROLLER) private readonly controller: OsServiceController) {}

  async execute(): Promise<SystemServiceView[]> {
    return Promise.all(
      SERVICE_CATALOG.map(async (service) => {
        const state = await this.controller.getState(service.unitName);
        return {
          id: service.id,
          displayName: service.displayName,
          category: service.category,
          description: service.description,
          riskLevel: service.riskLevel,
          riskNote: service.riskNote,
          ...state,
        };
      }),
    );
  }
}
