export const SHELL_SESSION_FACTORY = Symbol("SHELL_SESSION_FACTORY");

export interface ShellSession {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code: number | null) => void): void;
  kill(): void;
}

export interface ShellSessionFactory {
  spawn(containerName: string): ShellSession;
}
