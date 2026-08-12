import { Injectable } from "@nestjs/common";
import * as pty from "node-pty";
import type { ShellSession } from "../domain/shell-session";

class HostShellSession implements ShellSession {
  private proc: pty.IPty | null = null;
  private spawnErrorMessage: string | null = null;

  constructor() {
    // Shell direto no host (não docker exec): roda com o mesmo usuário
    // não-root do processo Core, sem argumentos vindos do cliente. Um PTY de
    // verdade (não pipe puro) é o que dá prompt, eco de digitação, cores e
    // controle de job - sem isso a tela fica muda até um comando terminar.
    try {
      this.proc = pty.spawn(process.env.SHELL ?? "bash", [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.env.HOME,
        env: process.env as Record<string, string>,
      });
    } catch (error) {
      // pty.spawn lança sincronamente (binário não encontrado, permissão
      // negada), diferente de child_process.spawn que emite "error" async.
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
      // Assíncrono de propósito: o gateway só registra esse callback DEPOIS
      // de chamar spawn(), então precisa rodar depois do construtor terminar.
      queueMicrotask(() => callback(this.spawnErrorMessage!));
    }
  }

  kill(): void {
    this.proc?.kill();
  }
}

@Injectable()
export class HostShellSessionFactory {
  spawn(): ShellSession {
    return new HostShellSession();
  }
}
