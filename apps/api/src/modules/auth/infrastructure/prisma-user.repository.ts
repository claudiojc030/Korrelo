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
    return row ? new User(row.id, row.email, row.passwordHash, row.createdAt) : null;
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
    return new User(row.id, row.email, row.passwordHash, row.createdAt);
  }
}
