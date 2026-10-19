"use client";

import { useEffect } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

/**
 * Fronteira de erro das páginas do painel.
 *
 * Antes, qualquer exceção de render (inclusive uma falha de rede dentro de
 * um Server Component) resultava na página de erro genérica do Next, sem
 * botão de recuperação. Agora o operador consegue tentar de novo sem
 * recarregar o navegador inteiro.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log no console do navegador (sem dados sensíveis: só a mensagem).
    console.error("[korrelo] erro ao renderizar a página:", error.message);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 px-8 py-16 text-center">
      <TriangleAlert size={22} className="text-destructive" />
      <h1 className="text-[15px] font-semibold text-foreground">Não foi possível carregar esta página</h1>
      <p className="max-w-md text-[13px] text-muted-foreground">
        A API pode estar indisponível ou lenta demais no momento. Tente de novo em instantes.
      </p>
      <button
        onClick={() => reset()}
        className="mt-2 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
      >
        <Loader2 size={14} className="animate-spin" />
        Tentar de novo
      </button>
    </div>
  );
}
