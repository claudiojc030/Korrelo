import * as crypto from "node:crypto";

// Verifica a assinatura HMAC-SHA256 que o GitHub manda no header
// X-Hub-Signature-256, calculada sobre o corpo BRUTO (não o JSON já
// parseado) usando o segredo configurado nas settings do GitHub App.
export function verifyGithubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(`sha256=${expected}`, "utf-8");
  const receivedBuffer = Buffer.from(signatureHeader, "utf-8");

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
