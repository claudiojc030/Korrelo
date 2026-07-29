import dynamic from "next/dynamic";
import { TriangleAlert } from "lucide-react";
import { getLocaleServer } from "../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../lib/i18n/dictionaries";

const SystemTerminalClient = dynamic(
  () => import("./system-terminal-client").then((mod) => mod.SystemTerminalClient),
  { ssr: false },
);

export default function SystemTerminalPage() {
  const t = getDictionary(getLocaleServer());

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-none items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3.5 py-2 text-[12.5px] text-warning">
        <TriangleAlert size={14} strokeWidth={1.75} className="flex-none" />
        {t.nav.systemTerminalWarning}
      </div>
      <div className="min-h-0 flex-1">
        <SystemTerminalClient />
      </div>
    </div>
  );
}
