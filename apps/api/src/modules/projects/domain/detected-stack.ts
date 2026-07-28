export interface DetectedStack {
  language: string;
  framework: string | null;
  packageManager: string | null;
  recommendedPort: number | null;
  startCommand: string | null;
  buildCommand: string | null;
}
