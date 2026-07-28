import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, SquareTerminal } from "lucide-react";

const TerminalClient = dynamic(
  () => import("./terminal-client").then((mod) => mod.TerminalClient),
  { ssr: false },
);

export default function TerminalPage({ params }: { params: { projectId: string } }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-border-subtle px-6 py-3.5">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} strokeWidth={1.75} />
          Projetos
        </Link>
        <span className="h-4 w-px bg-border-subtle" />
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <SquareTerminal size={15} strokeWidth={1.75} />
          Terminal
        </span>
      </div>
      <div className="min-h-0 flex-1 p-4">
        <TerminalClient projectId={params.projectId} />
      </div>
    </div>
  );
}
