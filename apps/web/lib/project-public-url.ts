interface ProjectUrlFields {
  assignedPort: number | null;
  customDomain: string | null;
  domainSslStatus: string;
}

// Prefere o domínio personalizado (com HTTPS) quando ele está anexado e ativo;
// cai pro IP:porta só quando não tem domínio, ou o certificado ainda não
// ficou pronto.
export function getProjectPublicUrl(project: ProjectUrlFields, host: string): { href: string; label: string } | null {
  if (project.customDomain && project.domainSslStatus === "active") {
    return { href: `https://${project.customDomain}`, label: project.customDomain };
  }
  if (project.assignedPort) {
    return { href: `http://${host}:${project.assignedPort}`, label: `${host}:${project.assignedPort}` };
  }
  return null;
}
