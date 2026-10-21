import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import type { ExecutionContext } from "@nestjs/common";
import { createHash } from "node:crypto";
import { apiError } from "./api-error";

// O ThrottlerGuard padrão joga uma ThrottlerException cuja mensagem é sempre
// o texto fixo em inglês "ThrottlerException: Too Many Requests" (o
// construtor força a mensagem pra string, então nem dá pra passar um objeto
// com "code" pra ela). Sem um "code", o translateApiError do frontend não
// acha tradução e mostra esse texto crú pro usuário.
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(_context: ExecutionContext, _detail: ThrottlerLimitDetail): Promise<void> {
    throw new HttpException(
      apiError("TOO_MANY_REQUESTS", "Muitas tentativas. Espere um minuto e tente de novo."),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * CHAVE DO RATE LIMIT.
   *
   * O padrão do throttler é `sha256(classe-método-nome-ip)`: a mesma chave
   * pra todo mundo atrás do mesmo IP, e a MESMA chave pras duas etapas do
   * login (senha e 2FA usam o mesmo POST /auth/login).
   *
   * Isso trancava o admin legítimo no próprio fluxo: 1 POST com a senha +
   * 1 POST com o código de 2FA = 2 das 5 tentativas do minuto. Bastava
   * errar o código 3 vezes (ou a página recarregar) pra o login cair em
   * 429 - e o operador ficava bloqueado por 60s sem ter errado a senha
   * nenhuma vez.
   *
   * Aqui a chave do login passa a separar:
   * - a ETAPA (senha x 2FA): o 2FA tem janela própria, então errar o
   *   código não consome a janela da senha;
   * - o USUÁRIO: um ataque de senha contra um username não bloqueia o
   *   admin, e o admin que erra a senha só esgota a janela DELE.
   *
   * O resto das rotas (inclusive o /auth/refresh) continua com a chave
   * padrão por IP - o refresh NÃO compartilha bucket com o login (a chave
   * já inclui o método do controller).
   */
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    const request = context.switchToHttp().getRequest();
    const stage = loginStageOf(request);
    if (!stage) {
      return super.generateKey(context, suffix, name);
    }
    const body = (request?.body ?? {}) as { username?: unknown };
    const username =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const prefix = `${context.getClass().name}-${context.getHandler().name}-${name}`;
    return createHash("sha256")
      .update(`${prefix}-${suffix}|${username}|${stage}`)
      .digest("hex");
  }
}

/**
 * A rota de login (POST /auth/login) aceita a senha E o código de 2FA no
 * MESMO corpo. A etapa é deduzida do corpo: com `twoFactorCode` preenchido
 * é a validação de 2FA; sem ele, é a validação de senha.
 */
function loginStageOf(request: { url?: string; originalUrl?: string; body?: unknown }): "password" | "two-factor" | null {
  const url = String(request?.originalUrl ?? request?.url ?? "");
  if (!url.includes("/auth/login")) return null;
  const body = (request?.body ?? {}) as { twoFactorCode?: unknown };
  const code = typeof body.twoFactorCode === "string" ? body.twoFactorCode.trim() : "";
  return code.length > 0 ? "two-factor" : "password";
}
