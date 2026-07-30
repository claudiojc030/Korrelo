export const SHELL_SESSION_FACTORY = Symbol("SHELL_SESSION_FACTORY");

export interface ShellSession {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code: number | null) => void): void;
  // Falha ao criar o processo em si (binário não encontrado, permissão
  // negada etc). Sem tratar isso, o Node derruba o processo INTEIRO da API
  // com uma exceção não tratada, não só essa sessão.
  onError(callback: (message: string) => void): void;
  kill(): void;
}

export interface ShellSessionFactory {
  spawn(containerName: string): ShellSession;
}
