import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../auth/presentation/public.decorator";
import { HandleGithubPushWebhookUseCase } from "../application/handle-github-push-webhook.use-case";
import { verifyGithubSignature } from "../infrastructure/github-webhook-signature";

interface GithubPushPayload {
  ref: string;
  repository: { clone_url: string };
}

@Controller("github")
export class GithubWebhookController {
  constructor(private readonly handlePushWebhook: HandleGithubPushWebhookUseCase) {}

  @Public()
  @Post("webhook")
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Headers("x-github-event") event: string | undefined,
  ) {
    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) {
      throw new BadRequestException("GITHUB_APP_WEBHOOK_SECRET não configurado nesta VPS.");
    }
    if (!req.rawBody || !verifyGithubSignature(secret, req.rawBody, signature)) {
      throw new BadRequestException("Assinatura do webhook inválida.");
    }

    if (event !== "push") {
      return { ok: true, ignored: event ?? "unknown" };
    }

    const payload = req.body as GithubPushPayload;
    const result = await this.handlePushWebhook.execute({
      repositoryCloneUrl: payload.repository.clone_url,
      ref: payload.ref,
    });
    return { ok: true, ...result };
  }
}
