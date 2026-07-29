import type { User } from "./user.entity";

export const USER_REPOSITORY = Symbol("USER_REPOSITORY");

export interface UserRepository {
  count(): Promise<number>;
  findByUsername(username: string): Promise<User | null>;
  findFirst(): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<User>;
  update(user: User): Promise<User>;
}
