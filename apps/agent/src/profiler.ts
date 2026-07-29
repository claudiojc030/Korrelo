import * as os from "node:os";
import { classifyResourceTier, type HardwareProfile } from "@korrelo/shared-types";

export function profileHardware(): HardwareProfile {
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

  return {
    vCpus: os.cpus().length,
    totalMemMb,
    freeMemMb,
    platform: `${os.platform()} ${os.release()}`,
    tier: classifyResourceTier(totalMemMb),
  };
}
