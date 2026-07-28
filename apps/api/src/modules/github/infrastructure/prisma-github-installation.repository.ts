import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { GithubInstallation } from "../domain/github-installation.entity";
import type { GithubInstallationRepository } from "../domain/github-installation.repository";

@Injectable()
export class PrismaGithubInstallationRepository implements GithubInstallationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLatest(): Promise<GithubInstallation | null> {
    const row = await this.prisma.githubInstallation.findFirst({ orderBy: { createdAt: "desc" } });
    return row
      ? new GithubInstallation(row.id, row.installationId, row.accountLogin, row.createdAt)
      : null;
  }

  async save(installation: GithubInstallation): Promise<GithubInstallation> {
    const row = await this.prisma.githubInstallation.upsert({
      where: { installationId: installation.installationId },
      create: {
        id: installation.id,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        createdAt: installation.createdAt,
      },
      update: {
        accountLogin: installation.accountLogin,
      },
    });
    return new GithubInstallation(row.id, row.installationId, row.accountLogin, row.createdAt);
  }
}
