export const TOKEN_SERVICE = Symbol("TOKEN_SERVICE");

export interface AuthTokenPayload {
  sub: string;
  username: string;
}

export interface TokenService {
  sign(payload: AuthTokenPayload): string;
  verify(token: string): AuthTokenPayload | null;
}
