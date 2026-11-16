import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCapacity } from "../lib/capacity-evaluate.mjs";
import { assertReadOnlyCommand } from "../vps-capacity-audit.mjs";

const healthy = {
  collectedAt: "2026-11-16T18:00:00.000Z",
  host: { nproc: 4, loadavg: [0.4, 0.5, 0.3] },
  memory: { totalMb: 8192, availableMb: 5000, freeMb: 1200, swapTotalMb: 2048, swapFreeMb: 1800 },
  psi: { memory: { full10: 0.0, some10: 0.2 } },
  oom: { events24h: 0, source: "journalctl" },
  disk: {
    root: { freeGb: 40, freeInodes: 900_000, totalInodes: 1_000_000 },
    docker: { freeGb: 40, freeInodes: 900_000, totalInodes: 1_000_000 },
  },
  docker: {
    reachable: true,
    containers: [
      { name: "mesatta", oomKilled: false, health: "healthy", restarts: 0 },
      { name: "evolution", oomKilled: false, health: "none", restarts: 0 },
    ],
  },
};

const withPatch = (patch) => {
  const clone = structuredClone(healthy);
  patch(clone);
  return clone;
};

test("host saudável libera atualização do Core e ativação do staging", () => {
  const evaluation = evaluateCapacity(healthy);
  assert.equal(evaluation.coreUpdate.verdict, "GO");
  assert.equal(evaluation.stagingActivation.verdict, "GO");
  assert.ok(evaluation.marginMb > 0);
});

test("RAM insuficiente bloqueia staging mas não a atualização do Core", () => {
  const evaluation = evaluateCapacity(withPatch((s) => (s.memory.availableMb = 1400)));
  assert.equal(evaluation.coreUpdate.verdict, "GO");
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
  assert.ok(evaluation.stagingActivation.failed.includes("staging.memAvailableMb"));
  assert.ok(evaluation.stagingActivation.failed.includes("staging.projectedMarginMb"));
});

test("OOM no kernel nas últimas 24h bloqueia os dois estágios", () => {
  const evaluation = evaluateCapacity(withPatch((s) => (s.oom.events24h = 2)));
  assert.equal(evaluation.coreUpdate.verdict, "NO-GO");
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
  assert.ok(evaluation.coreUpdate.failed.includes("kernel.oomEvents24h"));
});

test("OOM indisponível não é tratado como zero", () => {
  const evaluation = evaluateCapacity(withPatch((s) => (s.oom.events24h = null)));
  assert.equal(evaluation.coreUpdate.verdict, "NO-GO");
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
});

test("Docker inalcançável bloqueia tudo", () => {
  const evaluation = evaluateCapacity(withPatch((s) => (s.docker.reachable = false)));
  assert.equal(evaluation.coreUpdate.verdict, "NO-GO");
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
  assert.ok(evaluation.stagingActivation.failed.includes("docker.reachable"));
});

test("container OOMKilled ou unhealthy bloqueia tudo", () => {
  const evaluation = evaluateCapacity(
    withPatch((s) => {
      s.docker.containers[0].oomKilled = true;
      s.docker.containers[1].health = "unhealthy";
    }),
  );
  assert.ok(evaluation.coreUpdate.failed.includes("docker.oomContainers"));
  assert.ok(evaluation.coreUpdate.failed.includes("docker.unhealthyContainers"));
});

test("disco e inodes insuficientes bloqueiam staging", () => {
  const evaluation = evaluateCapacity(
    withPatch((s) => {
      s.disk.docker.freeGb = 4;
      s.disk.docker.freeInodes = 10_000;
    }),
  );
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
  assert.ok(evaluation.stagingActivation.failed.includes("staging.diskFreeGb"));
  assert.ok(evaluation.stagingActivation.failed.includes("staging.freeInodes"));
  assert.ok(evaluation.stagingActivation.failed.includes("staging.imagesReserveGb"));
});

test("pressão de memória e load por CPU bloqueiam staging", () => {
  const evaluation = evaluateCapacity(
    withPatch((s) => {
      s.psi.memory.full10 = 8;
      s.host.loadavg = [3, 3.5, 2];
    }),
  );
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
  assert.ok(evaluation.stagingActivation.failed.includes("staging.memoryPressureFull10"));
  assert.ok(evaluation.stagingActivation.failed.includes("staging.loadPerCpu"));
});

test("métrica ausente nunca vira aprovação", () => {
  const evaluation = evaluateCapacity({
    host: { nproc: null, loadavg: [] },
    memory: {},
    psi: {},
    oom: { events24h: null },
    disk: { root: {}, docker: {} },
    docker: { reachable: null, containers: [] },
  });
  assert.equal(evaluation.coreUpdate.verdict, "NO-GO");
  assert.equal(evaluation.stagingActivation.verdict, "NO-GO");
});

test("comando mutante é recusado pela allowlist", () => {
  for (const args of [
    ["rm", "-f", "x"],
    ["stop", "mesatta"],
    ["restart", "mesatta"],
    ["run", "-d", "img"],
    ["system", "prune", "-af"],
    ["volume", "rm", "vol"],
    ["exec", "mesatta", "sh"],
  ]) {
    assert.throws(() => assertReadOnlyCommand("docker", args), /recusado|fora da allowlist/, args.join(" "));
  }
});

test("comandos de leitura usados pela auditoria são aceitos", () => {
  for (const [command, args] of [
    ["docker", ["ps", "-q"]],
    ["docker", ["inspect", "--format", "{{.Name}}", "id"]],
    ["docker", ["stats", "--no-stream"]],
    ["docker", ["system", "df"]],
    ["docker", ["buildx", "du"]],
    ["docker", ["info", "--format", "{{.DockerRootDir}}"]],
    ["df", ["-Pk", "/"]],
    ["df", ["-Pki", "/"]],
    ["nproc", []],
    ["journalctl", ["-k", "--no-pager", "--since", "24 hours ago"]],
  ]) {
    assert.doesNotThrow(() => assertReadOnlyCommand(command, args), `${command} ${args.join(" ")}`);
  }
});
