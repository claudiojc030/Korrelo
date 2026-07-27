import { profileHardware } from "./profiler";

function main(): void {
  const profile = profileHardware();
  console.log("[forgedesk-agent] hardware profile:");
  console.log(JSON.stringify(profile, null, 2));
}

main();
