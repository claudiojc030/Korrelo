import { Injectable, InternalServerErrorException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import type { AuthTokenPayload, TokenService } from "../domain/token-service";

@Injectable()
export class JsonWebTokenService implements TokenService {
  private get secret(): string {
    const value = process.env.JWT_SECRET;
    if (!value) throw new InternalServerErrorException("JWT_SECRET não configurado");
    return value;
  }

  private get expiresIn(): string {
    return process.env.JWT_EXPIRES_IN ?? "12h";
  }

  sign(payload: AuthTokenPayload): string {
    const options: jwt.SignOptions = { expiresIn: this.expiresIn as jwt.SignOptions["expiresIn"] };
    return jwt.sign(payload, this.secret, options);
  }

  verify(token: string): AuthTokenPayload | null {
    try {
      return jwt.verify(token, this.secret) as unknown as AuthTokenPayload;
    } catch {
      return null;
    }
  }
}
