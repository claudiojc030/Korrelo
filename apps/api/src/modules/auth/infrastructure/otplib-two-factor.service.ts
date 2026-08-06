import { Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import * as otplib from "otplib";
import * as QRCode from "qrcode";
import type { TwoFactorService } from "../domain/two-factor-service";

const ISSUER = "Korrelo";

@Injectable()
export class OtplibTwoFactorService implements TwoFactorService {
  generateSecret(): string {
    return otplib.generateSecret();
  }

  buildOtpAuthUrl(username: string, secret: string): string {
    // strategy default é "totp", não precisa especificar.
    return otplib.generateURI({ issuer: ISSUER, label: username, secret });
  }

  async generateQrCodeDataUrl(otpAuthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpAuthUrl);
  }

  async verifyToken(secret: string, token: string): Promise<boolean> {
    try {
      // epochTolerance aceita ±1 passo de 30s (relógio do servidor com um
      // pouquinho de drift, ou o usuário demorando pra digitar) sem abrir
      // brecha de segurança relevante (ainda é só uma janela de ~1 minuto).
      const result = await otplib.verify({ secret, token, epochTolerance: 30 });
      return result.valid;
    } catch {
      // otplib lança em vez de retornar false quando o token não tem o
      // formato esperado (6 dígitos). Isso acontece o tempo todo aqui, já que o
      // LoginUseCase tenta TOTP primeiro mesmo quando a pessoa digitou um
      // código de backup (formato bem diferente).
      return false;
    }
  }

  generateBackupCodes(count: number): string[] {
    return Array.from({ length: count }, () => {
      const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
      return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    });
  }
}
