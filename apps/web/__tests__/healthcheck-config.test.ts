import {
  buildHealthcheckPayload,
  readHealthcheckConfig,
} from "../lib/healthcheck-config";

describe("healthcheck config helpers", () => {
  it("healthcheckConfig nulo permanece nulo (sem inventar config)", () => {
    expect(readHealthcheckConfig(null)).toBeNull();
    expect(readHealthcheckConfig(undefined)).toBeNull();
    expect(readHealthcheckConfig("")).toBeNull();
  });

  it("lê configuração existente com os campos do deploy", () => {
    const parsed = readHealthcheckConfig(
      JSON.stringify({
        enabled: true,
        path: "/healthz",
        intervalSeconds: 20,
        timeoutSeconds: 4,
        retries: 2,
        startPeriodSeconds: 90,
        deployPath: "/health/ready",
        deployTimeoutSeconds: 120,
      }),
    );
    expect(parsed).toMatchObject({
      enabled: true,
      path: "/healthz",
      deployPath: "/health/ready",
      deployTimeoutSeconds: 120,
    });
  });

  it("JSON inválido não derruba a tela", () => {
    expect(readHealthcheckConfig("{nao-json")).toBeNull();
  });

  it("salvar healthcheck Docker preserva deployPath/deployTimeoutSeconds", () => {
    const payload = buildHealthcheckPayload(
      {
        enabled: false,
        path: "/",
        intervalSeconds: 30,
        timeoutSeconds: 5,
        retries: 3,
        startPeriodSeconds: 120,
        deployPath: "/health/ready",
        deployTimeoutSeconds: 120,
      },
      { enabled: true, path: "/healthz", intervalSeconds: 10 },
    );
    expect(payload).toMatchObject({
      enabled: true,
      path: "/healthz",
      intervalSeconds: 10,
      deployPath: "/health/ready",
      deployTimeoutSeconds: 120,
    });
  });

  it("salvar saúde do deploy preserva os campos do healthcheck Docker", () => {
    const payload = buildHealthcheckPayload(
      {
        enabled: true,
        path: "/healthz",
        intervalSeconds: 20,
        timeoutSeconds: 4,
        retries: 2,
        startPeriodSeconds: 90,
      },
      { deployPath: "/health/ready", deployTimeoutSeconds: "120" },
    );
    expect(payload).toMatchObject({
      enabled: true,
      path: "/healthz",
      intervalSeconds: 20,
      timeoutSeconds: 4,
      retries: 2,
      startPeriodSeconds: 90,
      deployPath: "/health/ready",
      deployTimeoutSeconds: 120,
    });
  });

  it("caminho sem barra é normalizado e timeout inválido é removido", () => {
    const payload = buildHealthcheckPayload(null, {
      deployPath: "health/ready",
      deployTimeoutSeconds: "",
    });
    expect(payload.deployPath).toBe("/health/ready");
    expect(payload).not.toHaveProperty("deployTimeoutSeconds");
  });
});
