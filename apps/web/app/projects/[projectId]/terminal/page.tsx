import dynamic from "next/dynamic";

const TerminalClient = dynamic(
  () => import("./terminal-client").then((mod) => mod.TerminalClient),
  { ssr: false },
);

export default function TerminalPage({ params }: { params: { projectId: string } }) {
  return (
    <main className="flex min-h-screen flex-col items-center gap-4 py-8">
      <h1 className="text-lg font-semibold text-neutral-200">Terminal</h1>
      <TerminalClient projectId={params.projectId} />
    </main>
  );
}
