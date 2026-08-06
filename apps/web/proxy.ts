import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "./lib/auth-cookie-client";

// Proxy (ex-middleware) sempre roda em runtime Node.js no Next 16, então
// headers.getSetCookie() (usado abaixo pra separar múltiplos Set-Cookie
// corretamente) está sempre disponível, sem precisar declarar runtime.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
    try {
      const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=${refreshToken}` },
      });
      if (refreshRes.ok) {
        const response = NextResponse.next();
        for (const cookie of refreshRes.headers.getSetCookie()) {
          response.headers.append("set-cookie", cookie);
        }
        return response;
      }
    } catch {
      // API fora do ar ou rede falhou: cai pro redirect de login abaixo.
    }
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
