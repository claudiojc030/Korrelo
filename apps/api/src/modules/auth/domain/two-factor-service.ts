export const TWO_FACTOR_SERVICE = Symbol("TWO_FACTOR_SERVICE");

export interface TwoFactorService {
  generateSecret(): string;
  buildOtpAuthUrl(username: string, secret: string): string;
  generateQrCodeDataUrl(otpAuthUrl: string): Promise<string>;
  verifyToken(secret: string, token: string): Promise<boolean>;
  generateBackupCodes(count: number): string[];
}
