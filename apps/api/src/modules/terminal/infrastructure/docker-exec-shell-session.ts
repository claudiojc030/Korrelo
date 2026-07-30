import { Injectable } from "@nestjs/common";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ShellSession, ShellSessionFactory } from "../domain/shell-session";

class DockerExecShellSession implements ShellSession {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(containerName: string) {
    // spawn (não shell): containerName vem do banco (gerado por nós no deploy),
    // nunca de input direto do cliente do WebSocket, e mesmo assim, argumentos
    // de array nunca passam por interpretação de shell.
    this.child = spawn("docker", ["exec", "-i", containerName, "sh"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Sem um listener de "error", uma falha de spawn (docker não encontrado,
    // container removido no meio do caminho) derruba o processo Node inteiro,
    // não só essa sessão.
    this.child.on("error", () => {});
  }

  write(data: string): void {
    this.child.stdin.write(data);
  }

  onData(callback: (data: string) => void): void {
    this.child.stdout.on("data", (chunk: Buffer) => callback(chunk.toString("utf-8")));
    this.child.stderr.on("data", (chunk: Buffer) => callback(chunk.toString("utf-8")));
  }

  onExit(callback: (code: number | null) => void): void {
    this.child.on("exit", (code) => callback(code));
  }

  onError(callback: (message: string) => void): void {
    this.child.on("error", (error) => callback(error.message));
  }

  kill(): void {
    this.child.kill();
  }
}

@Injectable()
export class DockerExecShellSessionFactory implements ShellSessionFactory {
  spawn(containerName: string): ShellSession {
    return new DockerExecShellSession(containerName);
  }
}
