import { isMaskedValue, isSensitiveEnvKey, maskEnvValue, SECRET_MASK } from "../domain/core-env-secrets";

describe("core-env-secrets", () => {
  it("reconhece as variáveis sensíveis do Core", () => {
    expect(isSensitiveEnvKey("JWT_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("ENV_ENCRYPTION_KEY")).toBe(true);
    expect(isSensitiveEnvKey("GITHUB_APP_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvKey("GITHUB_APP_WEBHOOK_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("DATABASE_URL")).toBe(true);
    expect(isSensitiveEnvKey("REDIS_URL")).toBe(true);
    expect(isSensitiveEnvKey("BACKUP_ALERT_NTFY_TOPIC")).toBe(true);
  });

  it("não trata como sensível o que o admin precisa enxergar", () => {
    expect(isSensitiveEnvKey("PORT")).toBe(false);
    expect(isSensitiveEnvKey("KORRELO_WEB_URL")).toBe(false);
    expect(isSensitiveEnvKey("CORS_ORIGINS")).toBe(false);
    expect(isSensitiveEnvKey("GITHUB_APP_ID")).toBe(false);
    expect(isSensitiveEnvKey("GITHUB_APP_SLUG")).toBe(false);
    expect(isSensitiveEnvKey("BACKUP_DIR")).toBe(false);
  });

  it("mascara o valor das sensíveis e mantém o das outras", () => {
    expect(maskEnvValue("JWT_SECRET", "abc123")).toBe(SECRET_MASK);
    expect(maskEnvValue("PORT", "3001")).toBe("3001");
  });

  it("reconhece o valor mascarado", () => {
    expect(isMaskedValue(SECRET_MASK)).toBe(true);
    expect(isMaskedValue("abc123")).toBe(false);
  });
});
