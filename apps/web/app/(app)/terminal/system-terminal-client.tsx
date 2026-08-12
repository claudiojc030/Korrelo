"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useTranslation } from "../../../lib/i18n/locale-provider";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function SystemTerminalClient() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let term: import("@xterm/xterm").Terminal | undefined;
    let socket: import("socket.io-client").Socket | undefined;
    let fitAddon: import("@xterm/addon-fit").FitAddon | undefined;
    let handleResize: (() => void) | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }, { io }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("socket.io-client"),
      ]);

      if (disposed || !containerRef.current) return;

      term = new Terminal({
        convertEol: true,
        fontSize: 13,
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        theme: {
          background: "#0b1120",
          foreground: "#f8fafc",
          cursor: "#22c55e",
          selectionBackground: "#22c55e40",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      // Sem isso o terminal renderiza mas não recebe teclado: abrir o xterm
      // não move o foco sozinho, precisa ser pedido explicitamente.
      term.focus();
      containerRef.current.addEventListener("click", () => term?.focus());

      // withCredentials manda o cookie httpOnly de auth junto do handshake,
      // o gateway valida lendo esse cookie (ver system-terminal.gateway.ts).
      socket = io(`${API_URL}/system-terminal`, { withCredentials: true });
      socket.on("connect", () => {
        socket?.emit("start");
        socket?.emit("resize", { cols: term!.cols, rows: term!.rows });
      });
      socket.on("output", (data: string) => term?.write(data));
      socket.on("error", (message: string) => term?.write(`\r\n\x1b[31m${t.projectTerminal.connectionErrorPrefix} ${message}\x1b[0m\r\n`));
      socket.on("exit", () => term?.write(`\r\n\x1b[33m${t.projectTerminal.sessionEnded}\x1b[0m\r\n`));
      // Sem isso, uma falha no handshake do WebSocket (API fora do ar, CORS,
      // timeout) deixava a tela preta e muda pra sempre - nenhum dos handlers
      // acima dispara se a conexão nem chega a ser estabelecida.
      socket.on("connect_error", (error: Error) => {
        term?.write(`\r\n\x1b[31m${t.projectTerminal.connectionErrorPrefix} ${error.message}\x1b[0m\r\n`);
      });

      term.onData((data) => socket?.emit("input", data));
      term.onResize(({ cols, rows }) => socket?.emit("resize", { cols, rows }));

      handleResize = () => fitAddon?.fit();
      window.addEventListener("resize", handleResize);
    })();

    return () => {
      disposed = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      socket?.disconnect();
      term?.dispose();
    };
    // t só é usado dentro de callbacks de erro/saída; incluir na dependência
    // derrubaria e reconectaria a sessão de terminal toda vez que o idioma mudar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full overflow-hidden rounded-xl border border-border-subtle bg-[#0b1120] p-3">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
