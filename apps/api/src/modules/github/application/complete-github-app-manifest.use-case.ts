import { Injectable, InternalServerErrorException } from "@nestjs/common";
import * as path from "node:path";
import { apiError } from "../../../infrastructure/api-error";
import { upsertEnvValues } from "../../../infrastructure/env-file";

interface GithubManifestConversion {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
}

// Troca o "code" temporário que o GitHub manda de volta depois do fluxo de
// manifest (github.com/settings/apps/new com um <form manifest=...>) pelas
// credenciais reais do App recém-criado. Isso substitui os passos manuais de
// copiar App ID, gerar/baixar a private key e converter ela pra uma linha só
// com \n (ver README) — tudo já vem pronto na resposta dessa troca.
@Injectable()
export class CompleteGithubAppManifestUseCase {
  async execute(code: string): Promise<{ slug: string }> {
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new InternalServerErrorException(
        apiError("GITHUB_MANIFEST_EXCHANGE_FAILED", `Não foi possível concluir a criação do GitHub App (${res.status}): ${body}`),
      );
    }

    const data = (await res.json()) as GithubManifestConversion;
    const privateKeyEscaped = data.pem.replace(/\r?\n/g, "\\n");

    const envPath = path.join(process.cwd(), ".env");
    upsertEnvValues(envPath, {
      GITHUB_APP_ID: String(data.id),
      GITHUB_APP_SLUG: data.slug,
      GITHUB_APP_PRIVATE_KEY: privateKeyEscaped,
      GITHUB_APP_WEBHOOK_SECRET: data.webhook_secret,
    });

    // As mesmas variáveis já valem pro processo atual (os clients leem
    // process.env a cada chamada, não só no boot), então não precisa de
    // restart pra instalar o App logo em seguida.
    process.env.GITHUB_APP_ID = String(data.id);
    process.env.GITHUB_APP_SLUG = data.slug;
    process.env.GITHUB_APP_PRIVATE_KEY = privateKeyEscaped;
    process.env.GITHUB_APP_WEBHOOK_SECRET = data.webhook_secret;

    return { slug: data.slug };
  }
}
