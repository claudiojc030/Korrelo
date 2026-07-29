import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { EnvVarCipher } from "../../../infrastructure/crypto/env-var-cipher";
import { EnvVar } from "../domain/env-var.entity";
import type { EnvVarInput, EnvVarRepository } from "../domain/env-var.repository";

@Injectable()
export class PrismaEnvVarRepository implements EnvVarRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: EnvVarCipher,
  ) {}

  async findByProjectId(projectId: string): Promise<EnvVar[]> {
    const rows = await this.prisma.envVar.findMany({
      where: { projectId },
      orderBy: { key: "asc" },
    });
    return Promise.all(rows.map((row) => this.decryptAndHeal(row)));
  }

  // Se o valor ainda estiver em texto puro (gravado antes do
  // ENV_ENCRYPTION_KEY existir), cifra e persiste na primeira leitura, em vez
  // de deixar em texto puro pra sempre só porque ninguém editou aquele valor
  // de novo. Não precisa de uma migração à parte: a própria leitura já cura.
  private async decryptAndHeal(row: { id: string; projectId: string; key: string; value: string; createdAt: Date }): Promise<EnvVar> {
    const plainText = this.cipher.decrypt(row.value);
    if (this.cipher.isEncrypted(row.value)) {
      return new EnvVar(row.id, row.projectId, row.key, plainText, row.createdAt);
    }
    const reEncrypted = this.cipher.encrypt(plainText);
    await this.prisma.envVar.update({ where: { id: row.id }, data: { value: reEncrypted } });
    return new EnvVar(row.id, row.projectId, row.key, plainText, row.createdAt);
  }

  async replaceAll(projectId: string, vars: EnvVarInput[]): Promise<EnvVar[]> {
    await this.prisma.$transaction([
      this.prisma.envVar.deleteMany({ where: { projectId } }),
      this.prisma.envVar.createMany({
        data: vars.map((v) => ({ projectId, key: v.key, value: this.cipher.encrypt(v.value) })),
      }),
    ]);
    return this.findByProjectId(projectId);
  }

  async upsertOne(projectId: string, input: EnvVarInput): Promise<void> {
    const encrypted = this.cipher.encrypt(input.value);
    await this.prisma.envVar.upsert({
      where: { projectId_key: { projectId, key: input.key } },
      create: { projectId, key: input.key, value: encrypted },
      update: { value: encrypted },
    });
  }
}
