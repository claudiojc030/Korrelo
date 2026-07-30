import { Injectable } from "@nestjs/common";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ShellSession } from "../domain/shell-session";

class HostShellSession implements ShellSession {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor() {
    // Shell direto no host (não docker exec): roda com o mesmo usuário
    // não-root do processo Core, sem argumentos vindos do cliente.
    this.child = spawn(process.env.SHELL ?? "sh", [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.env.HOME,
    });
    // Sem um listener de "error", uma falha de spawn (binário não encontrado,
    // permissão negada) derruba o processo Node inteiro, não só essa sessão.
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
export class HostShellSessionFactory {
  spawn(): ShellSession {
    return new HostShellSession();
  }
}
