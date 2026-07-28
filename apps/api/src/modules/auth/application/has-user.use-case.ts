import { Inject, Injectable } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepository } from "../domain/user.repository";

@Injectable()
export class HasUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly repository: UserRepository) {}

  async execute(): Promise<boolean> {
    return (await this.repository.count()) > 0;
  }
}
