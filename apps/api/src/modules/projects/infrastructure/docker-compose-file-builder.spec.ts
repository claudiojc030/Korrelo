import { DockerComposeFileBuilder } from "./docker-compose-file-builder";
import type { DeployConfig } from "../domain/container-orchestrator";

function baseConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    projectPath: "/tmp/proj",
    containerName: "korrelo-app-1234abcd",
    hostPort: 3100,
    containerPort: 3000,
    memoryLimitMb: 700,
    staging: { containerName: "korrelo-app-1234abcd-staging", hostPort: 3101, memoryLimitMb: 300 },
    databases: [],
    imageName: "korrelo-app-1234abcd",
    imageTag: "commit-abc123def456",
    envFilePath: "/tmp/secrets/app-1234abcd/.env.korrelo",
    projectId: "1234abcd-0000-0000-0000-000000000000",
    deployJobId: "job-1",
    commitSha: "abc123def4567890",
    ...overrides,
  };
}

describe("DockerComposeFileBuilder (Wave 2)", () => {
  const builder = new DockerComposeFileBuilder();

  it("imagem versionada por commit, com a tag padrão do deploy", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    expect(compose).toContain("image: korrelo-app-1234abcd:${KORRELO_IMAGE_TAG:-commit-abc123def456}");
  });

  it("staging é efêmero: sem restart e com a label de temporário", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    const stagingBlock = compose.slice(compose.indexOf("  app_staging:"));

    expect(stagingBlock).toContain('restart: "no"');
    expect(stagingBlock).toContain('korrelo.ephemeral: "true"');
    expect(stagingBlock).toContain('korrelo.projectId: "1234abcd-0000-0000-0000-000000000000"');
    expect(stagingBlock).toContain('korrelo.deployJobId: "job-1"');
    expect(stagingBlock).toContain('korrelo.commitSha: "abc123def4567890"');
  });

  it("o app de produção NÃO é marcado como efêmero e continua com restart", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    const appBlock = compose.slice(compose.indexOf("  app:"), compose.indexOf("  app_staging:"));

    expect(appBlock).toContain("restart: unless-stopped");
    expect(appBlock).not.toContain("korrelo.ephemeral");
  });

  it("o arquivo de ambiente fica FORA do diretório do projeto", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    expect(compose).toContain("- /tmp/secrets/app-1234abcd/.env.korrelo");
  });

  it("staging tem limite de memória próprio (menor que o de produção)", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    expect(compose).toContain("mem_limit: 700m");
    expect(compose).toContain("mem_limit: 300m");
  });

  it("sem healthcheck configurado, o compose não ganha healthcheck", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    expect(compose).not.toContain("healthcheck:");
  });

  it("healthcheck configurado aparece com start_period (não reinicia app lento)", () => {
    const compose = builder.build(
      baseConfig({
        healthcheck: {
          enabled: true,
          path: "/healthz",
          intervalSeconds: 30,
          timeoutSeconds: 5,
          retries: 3,
          startPeriodSeconds: 120,
        },
      }),
      "Node.js",
    );

    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("interval: 30s");
    expect(compose).toContain("timeout: 5s");
    expect(compose).toContain("retries: 3");
    expect(compose).toContain("start_period: 120s");
    expect(compose).toContain("/healthz");
  });

  it("memswap_limit só é emitido quando configurado (default: comportamento atual)", () => {
    const without = builder.build(baseConfig(), "Node.js");
    expect(without).not.toContain("memswap_limit");

    const with_ = builder.build(baseConfig({ memswapLimitMb: 700 }), "Node.js");
    expect(with_).toContain("memswap_limit: 700m");
  });

  it("o heap do Node fica dentro do limite do container", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    // 700 * 0.7 = 490
    expect(compose).toContain('NODE_OPTIONS: "--max-old-space-size=490"');
  });

  it("só o app_staging recebe a identificação de ambiente de teste", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    const appBlock = compose.slice(compose.indexOf("  app:"), compose.indexOf("  app_staging:"));
    const stagingBlock = compose.slice(compose.indexOf("  app_staging:"));

    expect(stagingBlock).toContain('KORRELO_DEPLOY_ENV: "staging"');
    // Produção NUNCA recebe a variável.
    expect(appBlock).not.toContain("KORRELO_DEPLOY_ENV");
  });

  it("env_file exclusivo do staging só entra no app_staging", () => {
    const compose = builder.build(
      baseConfig({ stagingEnvFilePath: "/tmp/secrets/app-1234abcd/.env.korrelo.staging" }),
      "Node.js",
    );
    const appBlock = compose.slice(compose.indexOf("  app:"), compose.indexOf("  app_staging:"));
    const stagingBlock = compose.slice(compose.indexOf("  app_staging:"));

    expect(appBlock).not.toContain(".env.korrelo.staging");
    expect(stagingBlock).toContain("- /tmp/secrets/app-1234abcd/.env.korrelo.staging");
    // O arquivo comum continua valendo para os dois.
    expect(stagingBlock).toContain("- /tmp/secrets/app-1234abcd/.env.korrelo");
  });

  it("sem env extra, o staging usa apenas o arquivo comum", () => {
    const compose = builder.build(baseConfig(), "Node.js");
    const stagingBlock = compose.slice(compose.indexOf("  app_staging:"));

    expect(stagingBlock).not.toContain(".env.korrelo.staging");
  });
});
