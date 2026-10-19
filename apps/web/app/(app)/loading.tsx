/**
 * Estado de carregamento do painel. Antes, a navegação ficava em branco
 * enquanto o Server Component resolvia suas chamadas ao backend.
 */
export default function AppLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <div className="h-6 w-40 animate-pulse rounded bg-surface" />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-surface" />
        <div className="h-24 animate-pulse rounded-xl bg-surface" />
        <div className="h-24 animate-pulse rounded-xl bg-surface" />
      </div>
      <div className="mt-4 h-12 animate-pulse rounded-xl bg-surface" />
      <div className="mt-8 h-40 animate-pulse rounded-xl bg-surface" />
    </div>
  );
}
