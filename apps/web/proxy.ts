import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "./lib/auth-cookie-client";

// Proxy (ex-middleware) sempre roda em runtime Node.js no Next 16, então
// headers.getSetCookie() (usado abaixo pra separar múltiplos Set-Cookie
// corretamente) está sempre disponível, sem precisar declarar runtime.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Tempo limite do refresh de sessão. Sem isso, uma API lenta (ou travada
 * por carga) segurava a navegação inteira até o Nginx desistir com 504.
 */
const REFRESH_TIMEOUT_MS = 2_500;
/** Espera entre as duas tentativas de refresh. */
const RETRY_DELAY_MS = 500;

function extractCookieValue(setCookies: string[], name: string): string | null {
  const raw = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  return raw.split(";")[0].slice(name.length + 1);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/login") || pathname.startsWith("/setup")) {
    return NextResponse.next();
  }

  if (request.cookies.get(TOKEN_COOKIE)?.value) {
    return NextResponse.next();
  }

  // O access token dura só 15 minutos, mas a sessão (refresh token) dura 30
  // dias. Sem isso, qualquer navegação de página inteira (não passa pelo
  // apiFetch do cliente, que já sabe renovar sozinho) depois de 15 minutos
  // de inatividade mandava direto pro login, mesmo com sessão válida.
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (refreshToken) {
    // Até 2 tentativas: um restart do PM2 (deploy/atualização) deixa a API
    // fora do ar por 1-2s. Sem isso, um refresh que caísse bem nesse instante
    // via erro de REDE (não uma resposta 401 de verdade) deslogava o usuário
    // à toa, mesmo com a sessão perfeitamente válida.
    let apiResponded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          headers: { cookie: `${REFRESH_TOKEN_COOKIE}=${refreshToken}` },
          // Tempo limite: sem ele, uma API travada segura a navegação.
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
        apiResponded = true;
        if (refreshRes.ok) {
          const setCookies = refreshRes.headers.getSetCookie();
          // Sem isso, o Set-Cookie só valeria pra PRÓXIMA requisição do
          // navegador: essa aqui (a que disparou o refresh) ainda renderizava
          // Server Components com o cookie antigo/vazio, então qualquer fetch
          // que dependesse dele (ex.: authHeaderServer) falhava com 401 mesmo
          // a sessão sendo válida - piscava "API fora do ar" a cada ~15min.
          const newAccessToken = extractCookieValue(setCookies, TOKEN_COOKIE);
          if (newAccessToken) {
            request.cookies.set(TOKEN_COOKIE, newAccessToken);
          }
          const response = NextResponse.next({ request });
          for (const cookie of setCookies) {
            response.headers.append("set-cookie", cookie);
          }
          return response;
        }
        // Resposta de verdade (401 etc.): sessão inválida mesmo, não adianta tentar de novo.
        break;
      } catch {
        // Erro de rede/conexão recusada/TIMEOUT: só nesse caso vale tentar de
        // novo. Timeout é tratado como "API indisponível", não como
        // "sessão inválida" - deslogar o usuário por causa de lentidão seria
        // pior do que renderizar a página sem dados.
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    if (apiResponded) {
      // A API respondeu (401): a sessão é inválida mesmo. Mantém o
      // comportamento de antes - redireciona pro login.
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // A API não respondeu a tempo (ou recusou a conexão). A sessão pode estar
    // válida: em vez de expulsar o usuário pro login, segue com a navegação
    // - a página mostra o estado "API indisponível" e o próximo refresh
    // tenta de novo.
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
