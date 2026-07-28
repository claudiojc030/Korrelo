import * as path from "node:path";

const WORKSPACE_DIR = process.env.FORGEDESK_WORKSPACE_DIR ?? path.join(process.cwd(), "workspace");

export function getProjectWorkspacePath(projectId: string): string {
  return path.join(WORKSPACE_DIR, projectId);
}
