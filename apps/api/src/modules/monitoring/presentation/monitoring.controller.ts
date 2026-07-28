import { Controller, Get } from "@nestjs/common";
import { GetSystemMetricsUseCase } from "../application/get-system-metrics.use-case";

@Controller("monitoring")
export class MonitoringController {
  constructor(private readonly getSystemMetrics: GetSystemMetricsUseCase) {}

  @Get("system")
  system() {
    return this.getSystemMetrics.execute();
  }
}
