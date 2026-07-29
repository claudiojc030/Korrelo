import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { OsServiceController, ServiceState } from "../domain/os-service-controller";

const execFile = promisify(execFileCallback);

@Injectable()
export class SystemctlServiceController implements OsServiceController {
  async getState(unitName: string): Promise<ServiceState> {
    const exists = await this.unitExists(unitName);
    if (!exists) {
      return { exists: false, active: false, enabled: false };
    }
    const [active, enabled] = await Promise.all([this.isActive(unitName), this.isEnabled(unitName)]);
    return { exists: true, active, enabled };
  }

  async setEnabled(unitName: string, enabled: boolean): Promise<void> {
    const action = enabled ? "enable" : "disable";
    try {
      await execFile("sudo", ["systemctl", action, "--now", unitName], { timeout: 15_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`Falha ao ${action === "enable" ? "ativar" : "desativar"} "${unitName}": ${message}`);
    }
  }

  private async unitExists(unitName: string): Promise<boolean> {
    try {
      const { stdout } = await execFile("systemctl", ["list-unit-files", `${unitName}.service`]);
      return stdout.includes(`${unitName}.service`);
    } catch {
      return false;
    }
  }

  private async isActive(unitName: string): Promise<boolean> {
    try {
      const { stdout } = await execFile("systemctl", ["is-active", unitName]);
      return stdout.trim() === "active";
    } catch (error) {
      // "systemctl is-active" sai com código != 0 quando o serviço não está
      // ativo. Isso não é uma falha real, só o estado "inativo".
      const stdout = (error as { stdout?: string }).stdout;
      return stdout?.trim() === "active";
    }
  }

  private async isEnabled(unitName: string): Promise<boolean> {
    try {
      const { stdout } = await execFile("systemctl", ["is-enabled", unitName]);
      return stdout.trim().startsWith("enabled");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      return stdout?.trim().startsWith("enabled") ?? false;
    }
  }
}
