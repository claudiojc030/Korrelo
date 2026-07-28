import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { User } from "../domain/user.entity";
import type { UserRepository } from "../domain/user.repository";

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async count(): Promise<number> {
    return this.prisma.user.count();
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? this.toDomain(row) : null;
  }

  async findFirst(): Promise<User | null> {
    const row = await this.prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    return row ? this.toDomain(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async save(user: User): Promise<User> {
    const row = await this.prisma.user.create({
      data: {
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
      },
    });
    return this.toDomain(row);
  }

  async update(user: User): Promise<User> {
    const row = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: user.passwordHash,
        twoFactorSecret: user.twoFactorSecret,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorBackupCodes: JSON.stringify(user.twoFactorBackupCodes),
      },
    });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    email: string;
    passwordHash: string;
    twoFactorSecret: string | null;
    twoFactorEnabled: boolean;
    twoFactorBackupCodes: string | null;
    createdAt: Date;
  }): User {
    let backupCodes: string[] = [];
    if (row.twoFactorBackupCodes) {
      try {
        backupCodes = JSON.parse(row.twoFactorBackupCodes);
      } catch {
        backupCodes = [];
      }
    }
    return new User(row.id, row.email, row.passwordHash, row.twoFactorSecret, row.twoFactorEnabled, backupCodes, row.createdAt);
  }
}
