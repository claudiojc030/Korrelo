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
    return rows.map((row) => new EnvVar(row.id, row.projectId, row.key, this.cipher.decrypt(row.value), row.createdAt));
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
