import { Injectable } from "@nestjs/common";
import * as pty from "node-pty";
import type { ShellSession, ShellSessionFactory } from "../domain/shell-session";

class DockerExecShellSession implements ShellSession {
  private proc: pty.IPty | null = null;
  private spawnErrorMessage: string | null = null;

  constructor(containerName: string) {
    // spawn com array de argumentos (não shell): containerName vem do banco
    // (gerado por nós no deploy), nunca de input direto do cliente do
    // WebSocket, e mesmo assim argumentos de array nunca passam por
    // interpretação de shell. "-t" aloca um pty DENTRO do container também -
    // sem ele o "sh" lá dentro não mostra prompt nem ecoa digitação.
    try {
      this.proc = pty.spawn("docker", ["exec", "-it", containerName, "sh"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      });
    } catch (error) {
      this.spawnErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc?.resize(cols, rows);
  }

  onData(callback: (data: string) => void): void {
    this.proc?.onData(callback);
  }

  onExit(callback: (code: number | null) => void): void {
    this.proc?.onExit(({ exitCode }) => callback(exitCode));
  }

  onError(callback: (message: string) => void): void {
    if (this.spawnErrorMessage) {
      queueMicrotask(() => callback(this.spawnErrorMessage!));
    }
  }

  kill(): void {
    this.proc?.kill();
  }
}

@Injectable()
export class DockerExecShellSessionFactory implements ShellSessionFactory {
  spawn(containerName: string): ShellSession {
    return new DockerExecShellSession(containerName);
  }
}
