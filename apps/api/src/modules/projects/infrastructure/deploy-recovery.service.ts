import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DEPLOY_RECORD_REPOSITORY, type DeployRecordRepository } from "../domain/deploy-record.repository";

const INTERRUPTED_MESSAGE = "Interrompido por reinício do servidor Korrelo antes do deploy terminar.";

// Um deploy só é atualizado pelo processo que o iniciou (a promise inteira
// roda em memória) - se a API reiniciar no meio (self-update, pm2 restart,
// crash), o DeployRecord fica "running" pra sempre, e a UI mostra "Em
// andamento" indefinidamente mesmo o deploy de verdade estando morto. Isso
// varre e fecha qualquer sobra assim toda vez que a API sobe.
@Injectable()
export class DeployRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(DeployRecoveryService.name);

  constructor(
    @Inject(DEPLOY_RECORD_REPOSITORY) private readonly deployRecordRepository: DeployRecordRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const count = await this.deployRecordRepository.failAllRunning(INTERRUPTED_MESSAGE);
    if (count > 0) {
      this.logger.warn(`${count} deploy(s) travado(s) em "running" marcado(s) como falho após reinício.`);
    }
  }
}
