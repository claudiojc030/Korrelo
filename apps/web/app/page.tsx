async function getApiHealth() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/health`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ status: string; uptimeSeconds: number }>;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await getApiHealth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">ForgeDesk</h1>
      <p className="text-neutral-400">Web OS para desenvolvedores</p>
      <div className="rounded-full px-4 py-1 text-sm border border-neutral-800">
        {health ? (
          <span className="text-green-400">API online — uptime {health.uptimeSeconds}s</span>
        ) : (
          <span className="text-red-400">API offline (rode `npm run dev:api`)</span>
        )}
      </div>
    </main>
  );
}
