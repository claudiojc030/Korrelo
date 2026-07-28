import type { SystemMetrics } from "@forgedesk/shared-types";

export const SYSTEM_METRICS_COLLECTOR = Symbol("SYSTEM_METRICS_COLLECTOR");

export interface SystemMetricsCollector {
  collect(): Promise<SystemMetrics>;
}
