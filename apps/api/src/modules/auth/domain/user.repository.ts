import type { User } from "./user.entity";

export const USER_REPOSITORY = Symbol("USER_REPOSITORY");

export interface UserRepository {
  count(): Promise<number>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
}
