export const PASSWORD_HASHER = Symbol("PASSWORD_HASHER");

export interface PasswordHasher {
  hash(plainText: string): Promise<string>;
  compare(plainText: string, hash: string): Promise<boolean>;
}
