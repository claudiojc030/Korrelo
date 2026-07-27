import * as os from "node:os";
import type { HardwareProfile, ResourceTier } from "@forgedesk/shared-types";

const TIER_THRESHOLDS_MB: Array<{ tier: ResourceTier; maxMemMb: number }> = [
  { tier: "nano", maxMemMb: 1024 },
  { tier: "micro", maxMemMb: 4096 },
  { tier: "small", maxMemMb: 8192 },
  { tier: "medium", maxMemMb: 16384 },
  { tier: "large", maxMemMb: Infinity },
];

export function classifyTier(totalMemMb: number): ResourceTier {
  const match = TIER_THRESHOLDS_MB.find((t) => totalMemMb <= t.maxMemMb);
  return match ? match.tier : "large";
}

export function profileHardware(): HardwareProfile {
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

  return {
    vCpus: os.cpus().length,
    totalMemMb,
    freeMemMb,
    platform: `${os.platform()} ${os.release()}`,
    tier: classifyTier(totalMemMb),
  };
}
