export const OS_SERVICE_CONTROLLER = Symbol("OS_SERVICE_CONTROLLER");

export interface ServiceState {
  exists: boolean;
  active: boolean;
  enabled: boolean;
}

export interface OsServiceController {
  getState(unitName: string): Promise<ServiceState>;
  setEnabled(unitName: string, enabled: boolean): Promise<void>;
}
