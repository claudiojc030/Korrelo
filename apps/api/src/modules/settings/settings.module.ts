import { Module } from "@nestjs/common";
import { SettingsController } from "./presentation/settings.controller";
import { GetCoreDomainUseCase } from "./application/get-core-domain.use-case";
import { AttachCoreDomainUseCase } from "./application/attach-core-domain.use-case";
import { DetachCoreDomainUseCase } from "./application/detach-core-domain.use-case";
import { ListCoreEnvUseCase } from "./application/list-core-env.use-case";
import { SetCoreEnvVarUseCase } from "./application/set-core-env-var.use-case";
import { FileCoreDomainRepository } from "./infrastructure/file-core-domain.repository";
import { NginxCertbotCoreDomainProvisioner } from "./infrastructure/nginx-certbot-core-domain-provisioner";
import { FileCoreEnvRepository } from "./infrastructure/file-core-env.repository";
import { CORE_DOMAIN_REPOSITORY } from "./domain/core-domain-repository";
import { CORE_DOMAIN_PROVISIONER } from "./domain/core-domain-provisioner";
import { CORE_ENV_REPOSITORY } from "./domain/core-env.repository";

@Module({
  controllers: [SettingsController],
  providers: [
    GetCoreDomainUseCase,
    AttachCoreDomainUseCase,
    DetachCoreDomainUseCase,
    ListCoreEnvUseCase,
    SetCoreEnvVarUseCase,
    { provide: CORE_DOMAIN_REPOSITORY, useClass: FileCoreDomainRepository },
    { provide: CORE_DOMAIN_PROVISIONER, useClass: NginxCertbotCoreDomainProvisioner },
    { provide: CORE_ENV_REPOSITORY, useClass: FileCoreEnvRepository },
  ],
})
export class SettingsModule {}
