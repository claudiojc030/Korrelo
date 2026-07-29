import { Inject, Injectable } from "@nestjs/common";
import { SELF_UPDATER, type SelfUpdater } from "../domain/self-updater";

@Injectable()
export class GetSelfUpdateStatusUseCase {
  constructor(@Inject(SELF_UPDATER) private readonly updater: SelfUpdater) {}

  async execute() {
    return this.updater.getStatus();
  }
}
