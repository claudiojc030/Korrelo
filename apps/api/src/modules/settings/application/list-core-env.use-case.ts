import { Inject, Injectable } from "@nestjs/common";
import { CORE_ENV_REPOSITORY, type CoreEnvRepository, type CoreEnvVar } from "../domain/core-env.repository";

@Injectable()
export class ListCoreEnvUseCase {
  constructor(@Inject(CORE_ENV_REPOSITORY) private readonly envRepository: CoreEnvRepository) {}

  execute(): Promise<CoreEnvVar[]> {
    return this.envRepository.list();
  }
}
