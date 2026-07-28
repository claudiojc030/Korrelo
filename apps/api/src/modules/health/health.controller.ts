import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/presentation/public.decorator";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }
}
