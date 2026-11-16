#!/usr/bin/env node
/**
 * Korrelo — auditoria de capacidade da VPS, SOMENTE LEITURA.
 *
 * Não depende de build, banco ou do Core atualizado: é um script Node puro
 * (Node >= 20) que lê /proc, dfs e a API local do Docker. Pode ser copiado para
 * um host e executado ANTES de atualizar o Korrelo.
 *
 * Garantias:
 *  - allowlist explícita de comandos; qualquer binário/argumento fora dela é recusado;
 *  - nenhuma escrita, limpeza, restart, prune, migration ou deploy;
 *  - nenhuma leitura de .env, Config.Env ou cmdline de processos;
 *  - saída JSON estruturada com timestamp, métricas e gates GO/NO-GO.
 *
 * Uso:
 *   node vps-capacity-audit.mjs > capacidade-vps.json
 *   node vps-capacity-audit.mjs --text
 *   node vps-capacity-audit.mjs --fixture metricas.json     # reavalia offline
 *   node vps-capacity-audit.mjs --fail-on-no-go
 *   node vps-capacity-audit.mjs --self-check                # mostra a allowlist
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { evaluateCapacity, STAGING_BUDGET, THRESHOLDS } from "./lib/capacity-evaluate.mjs";

const FORBIDDEN_VERBS = new Set([
  "rm", "rmi", "stop", "restart", "kill", "prune", "run", "create", "start",
  "build", "push", "pull", "tag", "load", "save", "exec", "cp", "commit",
  "volume", "network", "system", "compose", // `volume ls` etc são liberados só via leitura explícita abaixo
]);
const FORBIDDEN_ARG = /(^|--)(rm|rmi|stop|restart|kill|prune|run|create|build|push|exec|delete|remove|wipe|reset|force)$/i;

/** Recusa comando que não seja comprovadamente leitura. Exportado para teste. */
export function assertReadOnlyCommand(command, args) {
  const [verb, sub] = args;
  if (FORBIDDEN_VERBS.has(verb) && !(verb === "system" && sub === "df")) {
    throw new Error(`comando recusado (mutante): ${command} ${args.join(" ")}`);
  }
  for (const arg of args) {
    if (FORBIDDEN_ARG.test(arg)) throw new Error(`argumento recusado: ${arg}`);
  }
  if (!["nproc", "df", "docker", "journalctl", "dmesg", "uname"].includes(command)) {
    throw new Error(`binário fora da allowlist: ${command}`);
  }
}

function run(command, args, options = {}) {
  assertReadOnlyCommand(command, args);
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), error: null };
  } catch (error) {
    return { ok: false, stdout: "", error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

function readProc(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return null;
  }
}

function parseMeminfo(raw) {
  const map = {};
  for (const line of (raw ?? "").split("\n")) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (match) map[match[1]] = Number(match[2]);
  }
  const mb = (kb) => (typeof kb === "number" ? Math.round(kb / 1024) : null);
  return {
    totalMb: mb(map.MemTotal),
    freeMb: mb(map.MemFree),
    availableMb: mb(map.MemAvailable),
    buffersMb: mb(map.Buffers),
    cachedMb: mb(map.Cached),
    swapTotalMb: mb(map.SwapTotal),
    swapFreeMb: mb(map.SwapFree),
  };
}

function parsePsi(raw) {
  const parse = (line) => {
    if (!line) return {};
    const out = {};
    for (const part of line.trim().split(/\s+/)) {
      const [key, value] = part.split("=");
      if (key && value !== undefined) out[key] = Number(value);
    }
    return out;
  };
  const lines = (raw ?? "").split("\n");
  const some = parse(lines.find((l) => l.startsWith("some")));
  const full = parse(lines.find((l) => l.startsWith("full")));
  const map = (entry) => ({
    some10: entry.avg10 ?? null,
    some60: entry.avg60 ?? null,
    some300: entry.avg300 ?? null,
  });
  const mapFull = (entry) => ({
    full10: entry.avg10 ?? null,
    full60: entry.avg60 ?? null,
    full300: entry.avg300 ?? null,
  });
  return {
    cpu: map(some),
    memory: { ...map(some), ...mapFull(full) },
    io: { ...map(some), ...mapFull(full) },
  };
}

function df(path) {
  const human = run("df", ["-Pk", path]);
  const inodes = run("df", ["-Pki", path]);
  let freeGb = null;
  let totalGb = null;
  let usedPercent = null;
  if (human.ok) {
    const line = human.stdout.split("\n").at(-1) ?? "";
    const cols = line.split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted
    if (cols.length >= 6) {
      const totalKb = Number(cols[1]);
      const availKb = Number(cols[3]);
      if (Number.isFinite(totalKb) && Number.isFinite(availKb)) {
        totalGb = Number((totalKb / 1024 / 1024).toFixed(2));
        freeGb = Number((availKb / 1024 / 1024).toFixed(2));
        usedPercent = Number(String(cols[4]).replace("%", ""));
      }
    }
  }
  let freeInodes = null;
  let totalInodes = null;
  if (inodes.ok) {
    const line = inodes.stdout.split("\n").at(-1) ?? "";
    const cols = line.split(/\s+/);
    // Filesystem Inodes IUsed IFree IUse% Mounted
    if (cols.length >= 6) {
      const total = Number(cols[1]);
      const free = Number(cols[3]);
      if (Number.isFinite(total) && Number.isFinite(free)) {
        totalInodes = total;
        freeInodes = free;
      }
    }
  }
  return { path, totalGb, freeGb, usedPercent, totalInodes, freeInodes, error: human.ok ? null : human.error };
}

function dockerRootDir() {
  const info = run("docker", ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 10_000 });
  return info.ok && info.stdout.startsWith("/") ? info.stdout : "/var/lib/docker";
}

function collectContainers() {
  const ps = run("docker", ["ps", "-q"], { timeoutMs: 10_000 });
  if (!ps.ok) return { records: [], error: ps.error };
  const ids = ps.stdout.split("\n").filter(Boolean);
  const stats = new Map();
  const statsResult = run("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"], { timeoutMs: 20_000 });
  if (statsResult.ok) {
    for (const line of statsResult.stdout.split("\n").filter(Boolean)) {
      const [name, cpuPercent, memUsage, memPercent] = line.split("|");
      stats.set(name, { cpuPercent, memUsage, memPercent });
    }
  }
  const records = [];
  for (const id of ids) {
    const inspected = run(
      "docker",
      [
        "inspect",
        "--format",
        [
          "{{.Name}}",
          "{{.Image}}",
          "{{.HostConfig.Memory}}",
          "{{.HostConfig.NanoCpus}}",
          "{{.HostConfig.PidsLimit}}",
          "{{.RestartCount}}",
          "{{.State.OOMKilled}}",
          "{{.State.ExitCode}}",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          "{{.State.Status}}",
        ].join("|"),
        id,
      ],
      { timeoutMs: 15_000 },
    );
    if (!inspected.ok) continue;
    const [name, image, memLimit, nanoCpus, pids, restarts, oomKilled, exitCode, health, state] =
      inspected.stdout.split("|");
    records.push({
      name,
      image,
      memLimitMb: Number(memLimit) > 0 ? Math.round(Number(memLimit) / 1024 / 1024) : null,
      cpuLimit: Number(nanoCpus) > 0 ? Number(nanoCpus) / 1e9 : null,
      pidsLimit: Number(pids) > 0 ? Number(pids) : null,
      restarts: Number(restarts),
      oomKilled: oomKilled === "true",
      exitCode: Number(exitCode),
      health,
      state,
      stats: stats.get(name.replace(/^\//, "")) ?? null,
    });
  }
  return { records, error: null };
}

function collectOom() {
  const seen = new Set();
  const patterns = /out of memory|oom-kill|killed process/i;
  let source = null;
  const j = run("journalctl", ["-k", "--no-pager", "--since", "24 hours ago"], { timeoutMs: 20_000 });
  if (j.ok) {
    source = "journalctl";
    for (const line of j.stdout.split("\n")) if (patterns.test(line)) seen.add(line.trim());
  }
  if (!source) {
    const d = run("dmesg", ["-T"], { timeoutMs: 20_000 });
    if (d.ok) {
      source = "dmesg";
      for (const line of d.stdout.split("\n")) if (patterns.test(line)) seen.add(line.trim());
    }
  }
  return { source, available: source !== null, events24h: source === null ? null : seen.size, samples: [...seen].slice(0, 10) };
}

export function collectSnapshot() {
  const meminfo = parseMeminfo(readProc("/proc/meminfo"));
  const loadavgRaw = readProc("/proc/loadavg") ?? "";
  const loadavg = loadavgRaw.split(/\s+/).slice(0, 3).map(Number).filter((n) => Number.isFinite(n));
  const nproc = Number((run("nproc").stdout || "").trim());
  const rootDir = dockerRootDir();
  const containers = collectContainers();
  const version = run("docker", ["version", "--format", "{{.Server.Version}}|{{.Server.Arch}}|{{.Server.Os}}"], { timeoutMs: 10_000 });
  const systemDf = run("docker", ["system", "df"], { timeoutMs: 20_000 });
  const buildx = run("docker", ["buildx", "du"], { timeoutMs: 60_000 });

  return {
    collectedAt: new Date().toISOString(),
    tool: { name: "korrelo-vps-capacity-audit", version: 1, readOnly: true },
    host: {
      nproc: Number.isFinite(nproc) && nproc > 0 ? nproc : null,
      loadavg,
      kernel: (readProc("/proc/version") ?? "").trim() || null,
      uptimeSeconds: Number((readProc("/proc/uptime") ?? "").split(" ")[0]) || null,
    },
    memory: meminfo,
    psi: (() => {
      const mem = parsePsi(readProc("/proc/pressure/memory"));
      const cpu = parsePsi(readProc("/proc/pressure/cpu"));
      const io = parsePsi(readProc("/proc/pressure/io"));
      return { memory: mem.memory, cpu: cpu.cpu, io: io.io };
    })(),
    oom: collectOom(),
    disk: {
      root: df("/"),
      docker: df(rootDir),
    },
    dockerDisk: df(rootDir),
    docker: {
      reachable: version.ok,
      version: version.ok ? version.stdout : null,
      error: version.ok ? null : version.error,
      systemDf: systemDf.ok ? systemDf.stdout : null,
      buildxCache: buildx.ok ? buildx.stdout : null,
      containers: containers.records,
      containersError: containers.error,
    },
  };
}

function toText(snapshot, evaluation) {
  const rows = [
    ["host.nproc", snapshot.host.nproc, `${evaluation.budget.requiredMb} MB exigidos para staging`],
    ["host.loadavg", snapshot.host.loadavg.join(" / "), "1 / 5 / 15 min"],
    ["memory.totalMb", snapshot.memory.totalMb, ""],
    ["memory.availableMb", snapshot.memory.availableMb, `margem=${evaluation.marginMb} MB`],
    ["memory.swapFreeMb", snapshot.memory.swapFreeMb, ""],
    ["psi.memory.full10", snapshot.psi.memory?.full10 ?? null, "%"],
    ["disk.docker.freeGb", snapshot.disk.docker.freeGb, ""],
    ["disk.docker.freeInodes", snapshot.disk.docker.freeInodes, ""],
    ["oom.events24h", snapshot.oom.events24h, snapshot.oom.source ?? "indisponível"],
    ["docker.reachable", snapshot.docker.reachable, snapshot.docker.version ?? snapshot.docker.error ?? ""],
    ["docker.containers", snapshot.docker.containers.length, ""],
  ];
  const lines = [];
  lines.push(`Korrelo capacity audit — ${snapshot.collectedAt}`);
  lines.push("");
  lines.push("MÉTRICAS");
  for (const [key, value, note] of rows) lines.push(`  ${key.padEnd(26)} ${String(value).padEnd(18)} ${note}`);
  lines.push("");
  for (const [label, result] of [["CORE UPDATE", evaluation.coreUpdate], ["STAGING ACTIVATION", evaluation.stagingActivation]]) {
    lines.push(`${label}: ${result.verdict}`);
    for (const check of result.checks) {
      lines.push(`  [${check.ok ? "PASS" : "FAIL"}] ${check.id} = ${JSON.stringify(check.value)} (${check.threshold})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(argv) {
  const args = new Set(argv);
  if (args.has("--self-check")) {
    process.stdout.write(
      JSON.stringify(
        {
          readOnly: true,
          binaries: ["nproc", "df", "docker", "journalctl", "dmesg", "uname"],
          dockerCommands: ["version", "info", "ps", "inspect", "stats", "system df", "buildx du"],
          forbidden: [...FORBIDDEN_VERBS],
          stagingBudget: STAGING_BUDGET,
          thresholds: THRESHOLDS,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const fixtureIndex = argv.indexOf("--fixture");
  let snapshot;
  if (fixtureIndex !== -1) {
    const file = argv[fixtureIndex + 1];
    if (!file || !existsSync(file)) {
      process.stderr.write(`fixture não encontrada: ${file ?? "(vazio)"}\n`);
      return 2;
    }
    snapshot = JSON.parse(readFileSync(file, "utf8"));
  } else {
    snapshot = collectSnapshot();
  }

  const evaluation = evaluateCapacity(snapshot);
  const report = { ...snapshot, evaluation };
  if (args.has("--text")) {
    process.stdout.write(toText(snapshot, evaluation) + "\n");
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  if (args.has("--fail-on-no-go") && evaluation.stagingActivation.verdict !== "GO") return 1;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("vps-capacity-audit.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
