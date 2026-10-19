import * as path from "node:path";

const WORKSPACE_DIR = process.env.KORRELO_WORKSPACE_DIR ?? path.join(process.cwd(), "workspace");

export function getProjectWorkspacePath(projectId: string): string {
  return path.join(WORKSPACE_DIR, projectId);
}

/**
 * Diretório do arquivo de ambiente do projeto - FORA do diretório do
 * projeto (e, portanto, fora do contexto de build).
 *
 * Motivo (achado DEP-06): com o .env.korrelo dentro do workspace, um
 * "COPY . ." de um Dockerfile próprio do dono do projeto copiava os
 * segredos do projeto pra dentro da imagem. Movendo o arquivo pra um
 * diretório IRMÃO, ele não é mais alcançado pelo contexto de build -
 * mesmo que o .dockerignore do projeto esteja errado ou ausente.
 */
export function getProjectSecretsDir(projectId: string): string {
  return path.join(WORKSPACE_DIR, `${projectId}-secrets`);
}

export function getProjectSecretsPath(projectId: string): string {
  return path.join(getProjectSecretsDir(projectId), ".env.korrelo");
}
