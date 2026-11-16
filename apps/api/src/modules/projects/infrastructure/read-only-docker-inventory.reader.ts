import { Injectable } from "@nestjs/common";
import { runCommand } from "../../../infrastructure/command-runner";
import type {
  StagingDockerInventoryReader,
  StagingDockerInventorySnapshot,
  DockerContainerInventory,
  DockerNetworkInventory,
  DockerVolumeInventory,
} from "../domain/staging-docker-inventory";

const INVENTORY_TIMEOUT_MS = 10_000;

/**
 * Inventário Docker SOMENTE LEITURA.
 *
 * Comandos permitidos: `docker ps -a`, `docker network ls`, `docker volume ls`.
 * Nenhum inspect de Config.Env, nenhum prune/rm/stop/down.
 * Saída incompleta => `complete=false` e o chamador deve falhar fechado.
 */
@Injectable()
export class ReadOnlyDockerInventoryReader implements StagingDockerInventoryReader {
  async inspect(): Promise<StagingDockerInventorySnapshot> {
    const empty: Omit<StagingDockerInventorySnapshot, "complete" | "error"> = {
      containers: [],
      networks: [],
      volumes: [],
      publishedPorts: [],
    };

    const containersResult = await this.runDocker([
      "ps",
      "-a",
      "--format",
      [
        "{{.ID}}",
        "{{.Names}}",
        "{{.State}}",
        "{{.Image}}",
        '{{.Label "com.docker.compose.project"}}',
        '{{.Label "korrelo.projectId"}}',
        '{{.Label "korrelo.deployJobId"}}',
        '{{.Label "korrelo.stagingRunId"}}',
        '{{.Label "korrelo.ephemeral"}}',
        "{{.Ports}}",
      ].join("\t"),
    ]);
    if (!containersResult.ok) return { ...empty, complete: false, error: containersResult.error };

    const networksResult = await this.runDocker(["network", "ls", "--format", "{{.Name}}"]);
    if (!networksResult.ok) return { ...empty, complete: false, error: networksResult.error };

    const volumesResult = await this.runDocker(["volume", "ls", "--format", "{{.Name}}"]);
    if (!volumesResult.ok) return { ...empty, complete: false, error: volumesResult.error };

    const networkNames = networksResult.stdout.split("\n").filter(Boolean);
    const volumeNames = volumesResult.stdout.split("\n").filter(Boolean);
    const networks: DockerNetworkInventory[] = [];
    for (const name of networkNames) {
      const labels = await this.readLabels("network", name);
      if (!labels.ok) return { ...empty, complete: false, error: labels.error };
      networks.push({ name, labels: labels.labels });
    }
    const volumes: DockerVolumeInventory[] = [];
    for (const name of volumeNames) {
      const labels = await this.readLabels("volume", name);
      if (!labels.ok) return { ...empty, complete: false, error: labels.error };
      volumes.push({ name, labels: labels.labels });
    }

    const containers: DockerContainerInventory[] = [];
    const publishedPorts = new Set<number>();
    for (const line of containersResult.stdout.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 9) {
        return { ...empty, complete: false, error: "Linha de container malformada no inventário." };
      }
      const [id, name, state, image, composeProject, projectId, deployJobId, stagingRunId, ephemeral, ports] = parts;
      const labels: Record<string, string> = {};
      if (composeProject) labels["com.docker.compose.project"] = composeProject;
      if (projectId) labels["korrelo.projectId"] = projectId;
      if (deployJobId) labels["korrelo.deployJobId"] = deployJobId;
      if (stagingRunId) labels["korrelo.stagingRunId"] = stagingRunId;
      if (ephemeral) labels["korrelo.ephemeral"] = ephemeral;
      const containerPorts: number[] = [];
      for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0) {
          containerPorts.push(port);
          publishedPorts.add(port);
        }
      }
      containers.push({
        id,
        name,
        state: state || null,
        image: image || null,
        labels,
        publishedPorts: containerPorts,
        composeProject: composeProject || null,
      });
    }

    return {
      complete: true,
      containers,
      networks,
      volumes,
      publishedPorts: [...publishedPorts],
      error: null,
    };
  }

  private async readLabels(
    kind: "network" | "volume",
    name: string,
  ): Promise<{ ok: true; labels: Record<string, string> } | { ok: false; error: string }> {
    const result = await this.runDocker([kind, "inspect", "--format", "{{json .Labels}}", name]);
    if (!result.ok) return { ok: false, error: result.error };
    const raw = result.stdout.trim();
    // `docker <kind> inspect --format '{{json .Labels}}'` devolve a STRING "null" (JSON válido) para
    // recurso sem labels — ex.: volume anônimo declarado pela imagem (mongo:7 cria /data/configdb).
    // Isso NÃO é falha de leitura e NÃO é dado malformado: é "sem labels". `null` vira conjunto
    // vazio, igual a `{}`. Ausência de labels NUNCA concede ownership a ninguém.
    if (raw === "" || raw === "null") return { ok: true, labels: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: `labels de ${kind} inválidas` };
      }
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") labels[key] = value;
      }
      return { ok: true, labels };
    } catch {
      return { ok: false, error: `labels de ${kind} inválidas` };
    }
  }

  private async runDocker(
    args: string[],
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
      const result = await runCommand("docker", args, { timeoutMs: INVENTORY_TIMEOUT_MS });
      if (result.timedOut || result.exitCode !== 0 || result.truncated) {
        return { ok: false, error: `docker ${args.slice(0, 2).join(" ")} indisponível/incompleto` };
      }
      return { ok: true, stdout: result.stdout };
    } catch {
      return { ok: false, error: `falha ao executar docker ${args.slice(0, 2).join(" ")}` };
    }
  }
}
