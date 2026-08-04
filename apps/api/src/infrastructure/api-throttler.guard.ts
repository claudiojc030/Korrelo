import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import type { ExecutionContext } from "@nestjs/common";
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
}
