import { ScheduleModule } from "@nestjs/schedule";
import { MonitoringModule } from "./monitoring.module";
import { ProjectsModule } from "../projects/projects.module";

/**
 * REGRESSÃO: um único ScheduleModule.forRoot() no processo.
 *
 * O `ScheduleModule.forRoot()` é global e cada chamada cria um
 * SchedulerOrchestrator próprio. Com dois, todo @Interval/@Cron é registrado
 * duas vezes: o coletor de métricas recebia dois ticks simultâneos e o
 * segundo via `collecting=true`, gerando o aviso falso de "coleta anterior
 * ainda em andamento".
 *
 * O ProjectsModule é o dono do forRoot. O MonitoringModule importa o
 * ProjectsModule e NÃO deve montar outro.
 */
function importsOf(moduleType: object): unknown[] {
  return (Reflect.getMetadata("imports", moduleType) as unknown[] | undefined) ?? [];
}

function isScheduleRoot(entry: unknown): boolean {
  if (entry === ScheduleModule) return true;
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { module?: unknown }).module === ScheduleModule
  );
}

describe("módulos — agendador único", () => {
  it("MonitoringModule não cria um segundo ScheduleModule.forRoot()", () => {
    const imports = importsOf(MonitoringModule);

    expect(imports).toContain(ProjectsModule);
    expect(imports.filter(isScheduleRoot)).toHaveLength(0);
  });

  it("ProjectsModule é a única origem do ScheduleModule.forRoot()", () => {
    const imports = importsOf(ProjectsModule);

    expect(imports.filter(isScheduleRoot)).toHaveLength(1);
  });
});
