import { Injectable } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  verifyPrebuiltImageIdentity,
  type StagingImageIdentityInput,
  type StagingImageIdentityResult,
  type StagingImageVerifier,
} from "../domain/staging-execution";

const execFile = promisify(execFileCallback);
const INSPECT_TIMEOUT_MS = 20_000;

/**
 * Verificador de imagem LOCAL pré-construída.
 *
 * Lê somente Id, RepoDigests, Labels, Os e Architecture. NUNCA lê Config.Env.
 * `latest` e ausência de labels de projeto/commit são recusadas pelo domínio.
 */
@Injectable()
export class DockerPrebuiltImageVerifier implements StagingImageVerifier {
  async verify(input: StagingImageIdentityInput): Promise<StagingImageIdentityResult> {
    try {
      const { stdout } = await execFile(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{.Id}}|{{json .RepoDigests}}|{{json .Config.Labels}}|{{.Os}}|{{.Architecture}}",
          input.imageReference,
        ],
        { timeout: INSPECT_TIMEOUT_MS },
      );
      const [imageId, digestsJson, labelsJson, os, architecture] = stdout.trim().split("|");
      const repoDigests = safeStringArray(digestsJson);
      const labels = safeLabels(labelsJson);
      return verifyPrebuiltImageIdentity({
        ...input,
        observed: {
          imageId: imageId ?? "",
          repoDigests,
          labels,
          os: os || null,
          architecture: architecture || null,
        },
      });
    } catch {
      return {
        ok: false,
        identityVerified: false,
        originAuthenticated: false,
        imageId: null,
        digest: null,
        issues: ["imagem local ausente ou Docker indisponível para inspeção"],
      };
    }
  }
}

function safeStringArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function safeLabels(value: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const labels: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === "string") labels[key] = entry;
    }
    return labels;
  } catch {
    return {};
  }
}
