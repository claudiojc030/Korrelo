"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function TerminalClient({ projectId }: { projectId: string }) {
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

      // withCredentials manda o cookie httpOnly de auth junto do handshake —
      // o gateway valida lendo esse cookie (ver terminal.gateway.ts).
      socket = io(`${API_URL}/terminal`, { withCredentials: true });
      socket.on("connect", () => socket?.emit("start", { projectId }));
      socket.on("output", (data: string) => term?.write(data));
      socket.on("error", (message: string) => term?.write(`\r\n\x1b[31m[erro] ${message}\x1b[0m\r\n`));
      socket.on("exit", () => term?.write("\r\n\x1b[33m[sessão encerrada]\x1b[0m\r\n"));

      term.onData((data) => socket?.emit("input", data));

      handleResize = () => fitAddon?.fit();
      window.addEventListener("resize", handleResize);
    })();

    return () => {
      disposed = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      socket?.disconnect();
      term?.dispose();
    };
  }, [projectId]);

  return (
    <div className="h-full overflow-hidden rounded-xl border border-border-subtle bg-[#0b1120] p-3">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
