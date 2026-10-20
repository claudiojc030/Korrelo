/**
 * Nome do container de um projeto no Docker.
 *
 * `korrelo-<slug-do-nome>-<8 chars do id>` - estável (o rollback e o
 * reconcile dependem do MESMO nome) e sem colisão entre projetos.
 */
export function sanitizeContainerName(projectId: string, projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `korrelo-${slug || "project"}-${projectId.slice(0, 8)}`;
}
