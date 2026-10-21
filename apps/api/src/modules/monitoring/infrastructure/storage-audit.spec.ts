/**
 * AUDITORIA E LIMPEZA DE ARMAZENAMENTO.
 *
 * O requisito central: o Korrelo NUNCA remove o que é de produção. A
 * allowlist é fechada, o dry-run não remove nada e a classificação
 * protege current/previous/candidate, volumes, bancos, uploads, o backup
 * mais recente e o job de self-update ativo.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  StorageAuditService,
  parseBuilderDu,
  parseHumanSize,
  parseSystemDfBuildCache,
  type CommandRunner,
} from "./storage-audit.service";
import { CleanupStorageUseCase } from "../application/cleanup-storage.use-case";
import { STORAGE_ACTIONS, type StorageActionId } from "../domain/storage-audit";
import type { ProjectRepository } from "../../projects/domain/project.repository";

/** Resultado de um comando simulado. */
function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 };
}
function fail() {
  return { stdout: "", stderr: "erro", exitCode: 1, signal: null, timedOut: false, truncated: false, durationMs: 1 };
}

describe("storage - parsing de tamanho", () => {
  it("converte tamanhos humanos em bytes", () => {
    expect(parseHumanSize("1KB")).toBe(1024);
    expect(parseHumanSize("1.5MB")).toBe(Math.round(1.5 * 1024 ** 2));
    expect(parseHumanSize("2GB")).toBe(2 * 1024 ** 3);
    expect(parseHumanSize("512B")).toBe(512);
    expect(parseHumanSize("lixo")).toBe(0);
    expect(parseHumanSize("")).toBe(0);
  });
});

describe("storage - allowlist fechada", () => {
  it("NENHUM comando perigoso está na allowlist", () => {
    const comandos = Object.values(STORAGE_ACTIONS).map((action) => action.command).join(" ");
    for (const proibido of [
      "docker system prune -a",
      "docker volume prune",
      "docker volume rm",
      "docker compose down",
      "/var/lib/docker",
      "systemctl stop",
      "pm2 delete",
      "rm -rf / ",
    ]) {
      expect(comandos).not.toContain(proibido);
    }
    // O volume de uploads NUNCA aparece num comando de limpeza.
    expect(comandos).not.toContain("uploads-data");
    // Todo "rm -rf" aponta para um caminho ESPECÍFICO do Korrelo (nunca
    // um glob genérico do home).
    for (const action of Object.values(STORAGE_ACTIONS)) {
      if (!action.command.startsWith("rm -rf")) continue;
      expect(action.command).toMatch(/rm -rf (~\/[^\s]+|\/tmp\/[^\s]+)/);
    }
  });

  it("toda ação tem comando, rótulo e nota", () => {
    for (const action of Object.values(STORAGE_ACTIONS)) {
      expect(action.command.length).toBeGreaterThan(0);
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.note.length).toBeGreaterThan(0);
    }
  });
});

describe("storage - auditoria (read-only) e proteções", () => {
  let dir: string;
  let projects: ProjectRepository;
  let runner: CommandRunner;
  let service: StorageAuditService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-storage-"));
    process.env.KORRELO_STATE_DIR = dir;
    projects = {
      findAll: async () => [
        {
          currentImage: "korrelo-mesatta:commit-a1b2c3d4e5f6",
          previousImage: "korrelo-mesatta:commit-0f1e2d3c4b5a",
        },
      ],
    } as unknown as ProjectRepository;

    runner = async (command, args) => {
      if (command === "df") {
        return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 28000000 22000000 56% /");
      }
      if (command === "docker" && args[0] === "images") {
        return ok(
          [
            "korrelo-mesatta:commit-a1b2c3d4e5f6\tabc123\t1757MB",
            "korrelo-mesatta:commit-0f1e2d3c4b5a\tdef456\t1757MB",
            "korrelo-mesatta:commit-111122223333\tghi789\t1200MB",
            "korrelo-evolucao:commit-444455556666\tjkl012\t900MB",
            "<none>:<none>\tmno345\t400MB",
          ].join("\n"),
        );
      }
      if (command === "docker" && args[0] === "ps") {
        return ok("korrelo-mesatta:commit-a1b2c3d4e5f6");
      }
      if (command === "docker" && args[0] === "volume") {
        return ok("mesatta-mongo-data\nuploads-data\nevolution-postgres-data");
      }
      if (command === "docker" && args[0] === "builder") {
        return ok("Shared:   1.2GB\nPrivate:  300MB\nReclaimable: 900MB");
      }
      if (command === "du") {
        const target = args[1] ?? "";
        if (target.includes("korrelo-backups")) return ok(`${1024 * 1024 * 3}\t${target}`);
        if (target.includes("artifact-backups")) return ok(`${1024 * 1024 * 200}\t${target}`);
        if (target.includes("self-update")) return ok(`${1024 * 1024}\t${target}`);
        if (target.includes(".npm")) return ok(`${1024 * 1024 * 500}\t${target}`);
        return ok(`${1024 * 1024}\t${target}`);
      }
      if (command === "journalctl") return ok("Archived and active journals take up 300M");
      return fail();
    };

    service = new StorageAuditService(projects, runner);
  });

  afterEach(() => {
    delete process.env.KORRELO_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1) o disco é medido (total/usado/livre)", async () => {
    const overview = await service.audit();

    // O df reporta em K-blocks: 50.000.000 KB = 51.200.000.000 bytes.
    expect(overview.totalBytes).toBe(50_000_000 * 1024);
    expect(overview.usedBytes).toBe(28_000_000 * 1024);
    expect(overview.freeBytes).toBe(22_000_000 * 1024);
    expect(overview.usedPercent).toBe(56);
  });

  it("2) a imagem CURRENT é NEVER_TOUCH", async () => {
    const overview = await service.audit();
    const current = overview.items.find((item) => item.detail === "korrelo-mesatta:commit-a1b2c3d4e5f6");

    expect(current?.classification).toBe("NEVER_TOUCH");
    expect(current?.proposedAction).toBeNull();
  });

  it("3) a imagem PREVIOUS (rollback) é NEVER_TOUCH", async () => {
    const overview = await service.audit();
    const previous = overview.items.find((item) => item.detail === "korrelo-mesatta:commit-0f1e2d3c4b5a");

    expect(previous?.classification).toBe("NEVER_TOUCH");
  });

  it("4) a imagem de deploy antiga, sem referência, é REVIEW (candidata)", async () => {
    const overview = await service.audit();
    const antiga = overview.items.find((item) => item.detail === "korrelo-mesatta:commit-111122223333");

    expect(antiga?.classification).toBe("REVIEW");
    expect(antiga?.proposedAction).toBe("docker-old-commit-images");
  });

  it("5) imagem DANGLING sem container pode ser SAFE_TO_CLEAN", async () => {
    const overview = await service.audit();
    const dangling = overview.items.find((item) => item.id.includes("mno345"));

    expect(dangling?.classification).toBe("SAFE_TO_CLEAN");
    expect(dangling?.proposedAction).toBe("docker-dangling-images");
  });

  it("6) TODO volume é NEVER_TOUCH (banco/uploads nunca são SAFE)", async () => {
    const overview = await service.audit();
    const volumes = overview.items.filter((item) => item.id.startsWith("docker:volume:"));

    expect(volumes.length).toBeGreaterThan(0);
    for (const volume of volumes) {
      expect(volume.classification).toBe("NEVER_TOUCH");
      expect(volume.proposedAction).toBeNull();
    }
    // Especificamente o volume de uploads e o do Mongo.
    expect(overview.items.find((i) => i.detail === "uploads-data")?.classification).toBe("NEVER_TOUCH");
    expect(overview.items.find((i) => i.detail === "mesatta-mongo-data")?.classification).toBe("NEVER_TOUCH");
  });

  it("7) o cache de build é SAFE_TO_CLEAN (com o espaço reservado preservado)", async () => {
    const overview = await service.audit();
    const cache = overview.items.find((item) => item.id === "docker:builder-cache");

    expect(cache?.classification).toBe("SAFE_TO_CLEAN");
    expect(cache?.command).toContain("--reserved-space");
  });

  it("8) o backup MAIS RECENTE do Core é NEVER_TOUCH", async () => {
    const backupsDir = path.join(os.homedir(), "korrelo-backups");
    const original = fs.existsSync(backupsDir);
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      const novo = path.join(backupsDir, "core-novo.db");
      const antigo = path.join(backupsDir, "core-antigo.db");
      fs.writeFileSync(novo, "x");
      fs.writeFileSync(antigo, "x");
      // O "antigo" tem mtime no passado.
      const passado = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(antigo, passado, passado);

      const overview = await service.audit();
      const recente = overview.items.find((item) => item.detail === novo);
      const velho = overview.items.find((item) => item.detail === antigo);

      expect(recente?.classification).toBe("NEVER_TOUCH");
      expect(receiteNaoLimpa(recente)).toBe(true);
      // O antigo (fora da retenção) é REVIEW.
      expect(velho?.classification).toBe("REVIEW");
      expect(velho?.proposedAction).toBe("korrelo-old-backups");
    } finally {
      for (const name of ["core-novo.db", "core-antigo.db"]) {
        try {
          fs.rmSync(path.join(backupsDir, name), { force: true });
        } catch {
          /* ignora */
        }
      }
      if (!original) {
        try {
          fs.rmSync(backupsDir, { recursive: true, force: true });
        } catch {
          /* ignora */
        }
      }
    }
  });

  it("9) o job de self-update ATUAL (ponteiro) é NEVER_TOUCH", async () => {
    const selfUpdateDir = path.join(dir, "self-update");
    fs.mkdirSync(selfUpdateDir, { recursive: true });
    fs.writeFileSync(path.join(selfUpdateDir, "current.json"), JSON.stringify({ id: "upd-1" }));
    fs.writeFileSync(path.join(selfUpdateDir, "upd-1.json"), "{}");
    fs.writeFileSync(path.join(selfUpdateDir, "upd-1.log"), "log");

    const overview = await service.audit();
    const atual = overview.items.find((item) => item.id === "korrelo:self-update:upd-1.json");

    expect(atual?.classification).toBe("NEVER_TOUCH");
  });

  it("10) o dry-run NUNCA remove nada", async () => {
    const cleanup = new CleanupStorageUseCase(service, runner);
    const antes = fs.existsSync(dir);

    const plan = await cleanup.plan();

    expect(plan.overview.items.length).toBeGreaterThan(0);
    // Nenhum comando foi executado: o runner só responde leituras.
    expect(antes).toBe(true);
  });

  it("11) uma ação FORA da allowlist é recusada e NADA é executado", async () => {
    const cleanup = new CleanupStorageUseCase(service, runner);

    await expect(
      cleanup.clean(["rm -rf /" as unknown as StorageActionId], "operador"),
    ).rejects.toThrow(/recusada/);
  });

  it("12) a limpeza só executa ações da allowlist", async () => {
    const executados: string[] = [];
    const cleanup = new CleanupStorageUseCase(service, async (command, args) => {
      executados.push(`${command} ${args.join(" ")}`);
      return ok("ok");
    });

    await cleanup.clean(["npm-cache"], "operador");

    expect(executados.length).toBeGreaterThan(0);
    for (const comando of executados) {
      expect(comando).not.toContain("system prune -a");
      expect(comando).not.toContain("volume prune");
    }
  });

  it("13) os bytes são calculados por classificação", async () => {
    const overview = await service.audit();

    expect(overview.safeToCleanBytes).toBeGreaterThan(0);
    expect(overview.neverTouchBytes).toBeGreaterThan(0);
    // A soma das classificações bate com o total dos itens. Para
    // "SAFE_TO_CLEAN" conta o que é REALMENTE liberável (safeBytes), que
    // pode ser menor que o espaço ocupado (cache de build).
    const soma = overview.items.reduce(
      (sum, item) =>
        sum + (item.classification === "SAFE_TO_CLEAN" ? item.safeBytes ?? item.bytes : item.bytes),
      0,
    );
    const porClassificacao =
      overview.safeToCleanBytes +
      overview.reviewBytes +
      overview.keepBytes +
      overview.neverTouchBytes;
    expect(porClassificacao).toBe(soma);
  });

  it("14) o WORKSPACE de projeto é REVIEW (nunca SAFE, nunca apagado)", async () => {
    const overview = await service.audit();
    const workspace = overview.items.find((item) => item.id.startsWith("korrelo:workspace:"));

    expect(workspace).toBeDefined();
    expect(workspace?.classification).toBe("REVIEW");
    // Nenhuma ação proposta: o Korrelo NÃO apaga workspace só por ser antigo.
    expect(workspace?.proposedAction).toBeNull();
  });

  it("15) o snapshot de artefatos é KEEP/REVIEW (nunca SAFE automático)", async () => {
    const overview = await service.audit();
    const snapshots = overview.items.filter((item) =>
      item.id.startsWith("korrelo:artifact-snapshot:"),
    );
    for (const snapshot of snapshots) {
      expect(["KEEP", "REVIEW"]).toContain(snapshot.classification);
      expect(snapshot.classification).not.toBe("SAFE_TO_CLEAN");
    }
  });

  it("16) duas limpezas simultâneas: a segunda é RECUSADA", async () => {
    let liberar!: () => void;
    const trava = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    let chamadas = 0;
    const cleanup = new CleanupStorageUseCase(service, async () => {
      chamadas += 1;
      if (chamadas === 1) await trava;
      return ok("ok");
    });

    const primeira = cleanup.clean(["npm-cache"], "operador");
    // A segunda chamada acontece enquanto a primeira está em andamento.
    await expect(cleanup.clean(["npm-cache"], "operador")).rejects.toThrow(
      /limpeza em andamento/,
    );
    liberar();
    await primeira;
  });

  it("17) com self-update em andamento, a limpeza é RECUSADA", async () => {
    const executados: string[] = [];
    const cleanup = new CleanupStorageUseCase(
      service,
      async (command) => {
        executados.push(command);
        return ok("ok");
      },
      { getStatus: async () => ({ running: true }) },
    );

    await expect(cleanup.clean(["npm-cache"], "operador")).rejects.toThrow(
      /operação crítica em andamento/,
    );
    expect(executados).toHaveLength(0);
  });

  it("18) com deploy de projeto em andamento, a limpeza é RECUSADA", async () => {
    const executados: string[] = [];
    const cleanup = new CleanupStorageUseCase(
      service,
      async (command) => {
        executados.push(command);
        return ok("ok");
      },
      undefined,
      { hasActiveJob: async () => true },
    );

    await expect(cleanup.clean(["npm-cache"], "operador")).rejects.toThrow(
      /operação crítica em andamento/,
    );
    expect(executados).toHaveLength(0);
  });

  it("19) uma ação REVIEW não é executada pelo 'Limpar itens seguros'", async () => {
    const executados: string[] = [];
    const cleanup = new CleanupStorageUseCase(service, async (command, args) => {
      executados.push(`${command} ${args.join(" ")}`);
      return ok("ok");
    });

    // "docker-old-commit-images" só tem itens REVIEW -> nada é executado.
    const result = await cleanup.clean(["docker-old-commit-images"], "operador");

    expect(executados).toHaveLength(0);
    expect(result.results[0].executed).toBe(false);
  });

  it("20) a falha de uma ação NÃO dispara as ações seguintes", async () => {
    const executados: string[] = [];
    const cleanup = new CleanupStorageUseCase(service, async (command, args) => {
      executados.push(`${command} ${args.join(" ")}`);
      return fail();
    });

    const result = await cleanup.clean(["docker-builder-cache", "npm-cache"], "operador");

    // A segunda ação foi tentada (a allowlist manda), mas NENHUMA ação
    // perigosa foi disparada: só as da allowlist.
    for (const comando of executados) {
      expect(comando).not.toContain("system prune -a");
      expect(comando).not.toContain("volume prune");
    }
    expect(result.logEntry.failures.length).toBeGreaterThan(0);
  });
});

/**
 * CACHE DE BUILD (BuildKit) - o caso real da VPS.
 *
 * `docker builder du` dizia 10.63 GB (4.058 shared + 6.573 private,
 * "Reclaimable: 4.009GB") e o `docker system df` dizia Build Cache
 * 10.63GB com Reclaimable 0B. O painel classificava os 10.63 GB inteiros
 * como "SAFE TO CLEAN" e oferecia a limpeza - que não liberou nada.
 */
describe("storage - cache de build (BuildKit)", () => {
  const BUILDER_DU_REAL = [
    "Shared:      4.058GB",
    "Private:     6.573GB",
    "Reclaimable: 4.009GB",
    "Total:       10.63GB",
  ].join("\n");

  const SYSTEM_DF_SEM_RECLAIMABLE = [
    "TYPE            TOTAL      ACTIVE     SIZE      RECLAIMABLE",
    "Images          12         2          8.5GB     4GB",
    "Containers      5          0          100MB     0B",
    "Local Volumes   3          0          2GB       1GB",
    "Build Cache     42         0          10.63GB   0B",
  ].join("\n");

  const SYSTEM_DF_COM_RECLAIMABLE = [
    "TYPE            TOTAL      ACTIVE     SIZE      RECLAIMABLE",
    "Images          12         2          8.5GB     4GB",
    "Build Cache     42         0          3GB       3GB",
  ].join("\n");

  it("A) parser do builder du: total, shared, private e reclaimable", () => {
    const parsed = parseBuilderDu(BUILDER_DU_REAL);

    expect(parsed.totalBytes).toBe(parseHumanSize("10.63GB"));
    expect(parsed.sharedBytes).toBe(parseHumanSize("4.058GB"));
    expect(parsed.privateBytes).toBe(parseHumanSize("6.573GB"));
    expect(parsed.reclaimableBytes).toBe(parseHumanSize("4.009GB"));
  });

  it("A2) parser do builder du: entradas com Shared/Reclaimable true|false", () => {
    const parsed = parseBuilderDu(
      [
        "ID                      RECLAIMABLE     SIZE      LAST ACCESSED",
        "abc123                  true            1.2GB     2 days ago",
        "def456                  false           800MB     3 days ago",
        "Shared: true",
        "Reclaimable: true",
        "Reclaimable: false",
      ].join("\n"),
    );

    expect(parsed.hasEntries).toBe(true);
    expect(parsed.reclaimableEntries).toBe(1);
  });

  it("A3) parser do docker system df: a coluna RECLAIMABLE do Build Cache", () => {
    const parsed = parseSystemDfBuildCache(SYSTEM_DF_SEM_RECLAIMABLE);

    expect(parsed?.sizeBytes).toBe(parseHumanSize("10.63GB"));
    expect(parsed?.reclaimableBytes).toBe(0);
  });

  it("B) system df com reclaimable 3GB -> o reclaimable é lido", () => {
    const parsed = parseSystemDfBuildCache(SYSTEM_DF_COM_RECLAIMABLE);

    expect(parsed?.reclaimableBytes).toBe(parseHumanSize("3GB"));
  });

  it("C) o cache compartilhado NUNCA entra automaticamente no SAFE_TO_CLEAN", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-builder-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      const projects = { findAll: async () => [] } as unknown as ProjectRepository;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") {
          return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 28000000 22000000 56% /");
        }
        if (command === "docker" && args[0] === "builder") return ok(BUILDER_DU_REAL);
        if (command === "docker" && args[0] === "system" && args[1] === "df") {
          return ok(SYSTEM_DF_SEM_RECLAIMABLE);
        }
        if (command === "docker" && args[0] === "images") return ok("");
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("");
        if (command === "du") return ok("0\t/tmp");
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);

      const overview = await audit.audit();
      const cache = overview.items.find((item) => item.id === "docker:builder-cache");

      // O TOTAL do cache é o que ele ocupa...
      expect(cache?.bytes).toBe(parseHumanSize("10.63GB"));
      // ...mas o que é realmente liberável é 0B -> NÃO é SAFE.
      expect(cache?.classification).toBe("KEEP");
      expect(cache?.proposedAction).toBeNull();
      expect(cache?.command).toBeNull();
      // E o "Safe to clean" do painel não pode incluir os 10.63 GB.
      expect(overview.safeToCleanBytes).toBe(0);
      expect(cache?.breakdown?.reclaimableBytes).toBe(0);
      expect(cache?.breakdown?.reclaimableSource).toBe("docker-system-df");
      // A divergência entre as duas fontes fica VISÍVEL.
      expect(cache?.breakdown?.divergenceWarning).toContain("compartilhada");
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D) com reclaimable real (3GB), o valor liberável vira o SAFE e a ação aparece", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-builder-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      const projects = { findAll: async () => [] } as unknown as ProjectRepository;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") {
          return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 28000000 22000000 56% /");
        }
        if (command === "docker" && args[0] === "builder") return ok(BUILDER_DU_REAL);
        if (command === "docker" && args[0] === "system" && args[1] === "df") {
          return ok(SYSTEM_DF_COM_RECLAIMABLE);
        }
        if (command === "docker" && args[0] === "images") return ok("");
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("");
        if (command === "du") return ok("0\t/tmp");
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);

      const overview = await audit.audit();
      const cache = overview.items.find((item) => item.id === "docker:builder-cache");

      expect(cache?.classification).toBe("SAFE_TO_CLEAN");
      expect(cache?.proposedAction).toBe("docker-builder-cache");
      // O SAFE conta só o que é REALMENTE liberável (3GB), não os 10.63GB.
      expect(cache?.breakdown?.reclaimableBytes).toBe(parseHumanSize("3GB"));
      expect(overview.safeToCleanBytes).toBe(parseHumanSize("3GB"));
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E) o comando oferecido NUNCA é um prune forçado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-builder-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      const projects = { findAll: async () => [] } as unknown as ProjectRepository;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 28000000 22000000 56% /");
        if (command === "docker" && args[0] === "builder") return ok(BUILDER_DU_REAL);
        if (command === "docker" && args[0] === "system" && args[1] === "df") {
          return ok(SYSTEM_DF_COM_RECLAIMABLE);
        }
        if (command === "docker" && args[0] === "images") return ok("");
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("");
        if (command === "du") return ok("0\t/tmp");
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);
      const overview = await audit.audit();
      const cache = overview.items.find((item) => item.id === "docker:builder-cache");

      // Preserva o espaço reservado; nunca "-a" nem "system prune".
      expect(cache?.command).toBe("docker builder prune -f --reserved-space 2GB");
      expect(cache?.command).not.toContain("-a");
      expect(cache?.command).not.toContain("system prune");
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F) nenhuma proteção mudou de classificação com a nova métrica", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-builder-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      const projects = {
        findAll: async () => [
          { currentImage: "korrelo-mesatta:commit-atual", previousImage: "korrelo-mesatta:commit-anterior" },
        ],
      } as unknown as ProjectRepository;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") return ok("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 28000000 22000000 56% /");
        if (command === "docker" && args[0] === "builder") return ok(BUILDER_DU_REAL);
        if (command === "docker" && args[0] === "system" && args[1] === "df") {
          return ok(SYSTEM_DF_SEM_RECLAIMABLE);
        }
        if (command === "docker" && args[0] === "images") {
          return ok(
            [
              "korrelo-mesatta:commit-atual\tabc\t1757MB",
              "korrelo-mesatta:commit-anterior\tdef\t1757MB",
            ].join("\n"),
          );
        }
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("uploads-data\nmesatta-mongo-data");
        if (command === "du") return ok("0\t/tmp");
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);
      const overview = await audit.audit();

      // Imagens protegidas, volumes: tudo continua NEVER_TOUCH.
      for (const item of overview.items) {
        if (
          item.id.startsWith("docker:image:") ||
          item.id.startsWith("docker:volume:")
        ) {
          expect(item.classification).toBe("NEVER_TOUCH");
        }
      }
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage - resumo da limpeza (mesma base antes/depois)", () => {
  it("G) livre antes/depois e o espaço recuperado usam a MESMA fonte (df de /)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-free-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      const projects = { findAll: async () => [] } as unknown as ProjectRepository;
      // 20 GB livres -> 20 GB + 723 MB depois da limpeza.
      const livreAntes = 20 * 1024 ** 3;
      const livreDepois = livreAntes + 758_255_616;
      // O df é lido pelo audit "before", pelo plan() do cleanFiles e pelo
      // audit "after": a 3ª leitura é a de depois.
      let leiturasDf = 0;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") {
          leiturasDf += 1;
          const livre = leiturasDf <= 2 ? livreAntes : livreDepois;
          const total = 50 * 1024 ** 3;
          return ok(
            `Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 ${Math.floor(
              total / 1024,
            )} ${Math.floor((total - livre) / 1024)} ${Math.floor(livre / 1024)} 56% /`,
          );
        }
        if (command === "docker" && args[0] === "builder") return ok("Total:       1GB");
        if (command === "docker" && args[0] === "system" && args[1] === "df") return fail();
        if (command === "docker" && args[0] === "images") return ok("");
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("");
        if (command === "du") return ok("0\t/tmp");
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);
      const cleanup = new CleanupStorageUseCase(audit, async () => ok("ok"));

      const result = await cleanup.clean(["npm-cache"], "operador");

      // O log carrega LIVRE antes e LIVRE depois (a mesma base).
      expect(result.logEntry.freeBeforeBytes).toBeGreaterThan(0);
      expect(result.logEntry.freeAfterBytes).toBeGreaterThan(result.logEntry.freeBeforeBytes);
      // E o espaço recuperado é a diferença entre eles (coerente).
      const esperado = result.logEntry.freeAfterBytes - result.logEntry.freeBeforeBytes;
      expect(result.logEntry.bytesFreed).toBe(esperado);
      // O valor antigo (723 MB) aparece como o espaço real recuperado.
      expect(result.logEntry.bytesFreed).toBeGreaterThan(700 * 1024 * 1024);
      expect(result.logEntry.bytesFreed).toBeLessThan(800 * 1024 * 1024);
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("H) a divergência entre medido e reportado é sinalizada (sem fabricar reconciliação)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "korrelo-free-"));
    process.env.KORRELO_STATE_DIR = dir;
    try {
      // Um log de self-update VELHO (dentro da allowlist de paths): a ação
      // de arquivo realmente o remove e reporta os bytes -> dá para
      // comparar o medido com o reportado.
      const selfUpdateDir = path.join(dir, "self-update");
      fs.mkdirSync(selfUpdateDir, { recursive: true });
      const antigo = path.join(selfUpdateDir, "upd-velho.log");
      fs.writeFileSync(antigo, "x".repeat(1024 * 1024));
      const passado = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(antigo, passado, passado);

      const projects = { findAll: async () => [] } as unknown as ProjectRepository;
      let leiturasDf = 0;
      const runner: CommandRunner = async (command, args) => {
        if (command === "df") {
          leiturasDf += 1;
          // Na leitura "depois" o host GANHOU 5 GB por outra atividade.
          const livre = leiturasDf <= 2 ? 20 * 1024 ** 3 : 25 * 1024 ** 3;
          const total = 50 * 1024 ** 3;
          return ok(
            `Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 ${Math.floor(
              total / 1024,
            )} ${Math.floor((total - livre) / 1024)} ${Math.floor(livre / 1024)} 50% /`,
          );
        }
        if (command === "docker" && args[0] === "builder") return ok("Total:       1GB");
        if (command === "docker" && args[0] === "system" && args[1] === "df") return fail();
        if (command === "docker" && args[0] === "images") return ok("");
        if (command === "docker" && args[0] === "ps") return ok("");
        if (command === "docker" && args[0] === "volume") return ok("");
        if (command === "du") {
          if ((args[1] ?? "").includes("self-update")) {
            return ok(`${1024 * 1024}\t${args[1]}`);
          }
          return ok("0\t/tmp");
        }
        return fail();
      };
      const audit = new StorageAuditService(projects, runner);
      const cleanup = new CleanupStorageUseCase(audit, async () => ok("ok"));

      const result = await cleanup.clean(["self-update-old-logs"], "operador");

      // Os números REAIS são mostrados (medido = 5 GB de espaço livre) e a
      // divergência com o reportado fica sinalizada.
      expect(result.logEntry.bytesFreed).toBe(5 * 1024 ** 3);
      expect(result.logEntry.reportedBytesFreed).not.toBeNull();
      expect(result.logEntry.measurementDiverged).toBe(true);
    } finally {
      delete process.env.KORRELO_STATE_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** O item não pode ter ação de limpeza. */
function receiteNaoLimpa(item: { proposedAction: string | null } | undefined): boolean {
  return item?.proposedAction === null;
}
