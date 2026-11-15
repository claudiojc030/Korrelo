import { randomBytes } from "node:crypto";
import type { StagingPlanDependency } from "./staging-planner";

/**
 * MongoDB EFÊMERO POR StagingRun.
 *
 * Gera credenciais aleatórias, URI interna e healthcheck. Nunca lê banco,
 * variável ou segredo de produção; nunca publica porta do Mongo.
 */
export interface EphemeralMongoInput {
  dependency: StagingPlanDependency;
  /** Sobrescreve o banco padrão ("staging"); validado. */
  database?: string | null;
  image?: string;
}

export interface EphemeralMongoPlan {
  dependencyName: string;
  serviceName: string;
  database: string;
  username: string;
  password: string;
  appEnvKey: string;
  appEnv: Record<string, string>;
  dependencyEnv: Record<string, string>;
  healthcheck: string;
  image: string;
}

export interface EphemeralMongoResult {
  ok: boolean;
  plan: EphemeralMongoPlan | null;
  issues: string[];
}

const RESERVED_ENV = /^(KORRELO_|COMPOSE_|DOCKER_|PATH$|HOME$)/;
const DATABASE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function buildEphemeralMongo(input: EphemeralMongoInput): EphemeralMongoResult {
  const dependency = input.dependency;
  const issues: string[] = [];
  if (!dependency || dependency.mode !== "ephemeral") {
    issues.push("dependência MongoDB precisa ser efêmera");
  }
  if (!dependency?.serviceName) {
    issues.push("dependência MongoDB sem serviço no plano");
  }
  const envKey = dependency?.envKey?.trim() ?? "";
  if (!envKey) {
    issues.push("dependência MongoDB exige envKey explícito");
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    issues.push("envKey do MongoDB é inválido");
  } else if (RESERVED_ENV.test(envKey)) {
    issues.push("envKey do MongoDB não pode sobrescrever variável crítica");
  }
  const database = (input.database ?? dependency?.target?.database ?? "staging").trim().toLowerCase();
  if (!DATABASE_PATTERN.test(database)) {
    issues.push("nome do banco temporário é inválido");
  }
  if (issues.length > 0) return { ok: false, plan: null, issues };

  const username = `korrelo_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(18).toString("base64url");
  const serviceName = dependency.serviceName as string;
  const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${serviceName}:27017/${database}?authSource=admin`;

  return {
    ok: true,
    issues: [],
    plan: {
      dependencyName: dependency.name,
      serviceName,
      database,
      username,
      password,
      appEnvKey: envKey,
      appEnv: { [envKey]: uri },
      dependencyEnv: {
        MONGO_INITDB_ROOT_USERNAME: username,
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_INITDB_DATABASE: database,
      },
      healthcheck:
        "mongosh --quiet --eval \"db.adminCommand('ping').ok\" | grep -q 1",
      image: input.image ?? "mongo:7",
    },
  };
}
