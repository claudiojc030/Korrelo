import dynamic from "next/dynamic";

const TerminalClient = dynamic(
  () => import("./terminal-client").then((mod) => mod.TerminalClient),
  { ssr: false },
);

export default function TerminalPage({ params }: { params: { projectId: string } }) {
  return (
    <div className="min-h-0 flex-1 p-4">
      <TerminalClient projectId={params.projectId} />
    </div>
  );
}
