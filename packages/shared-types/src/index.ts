export type ProjectStatus = "detected" | "configuring" | "running" | "stopped" | "failed";

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  detectedStack: string | null;
  status: ProjectStatus;
  createdAt: string;
}

export interface DetectedStack {
  language: string;
  framework: string | null;
  packageManager: string | null;
  recommendedPort: number | null;
  startCommand: string | null;
  buildCommand: string | null;
}

export interface GithubRepositorySummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export type ResourceTier = "nano" | "micro" | "small" | "medium" | "large";

export interface HardwareProfile {
  vCpus: number;
  totalMemMb: number;
  freeMemMb: number;
  platform: string;
  tier: ResourceTier;
}
