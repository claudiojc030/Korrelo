import { DiskUsageAlertScheduler } from "./disk-usage-alert.scheduler";
import type { ProjectRepository } from "../domain/project.repository";
import type { ProjectDiskUsageService } from "./project-disk-usage.service";

/**
 * O scheduler continua funcionando; o hotfix apenas impede que ele seja
 * registrado duas vezes pelo ScheduleModule global.
 */
describe("DiskUsageAlertScheduler", () => {
  const previousTopic = process.env.BACKUP_ALERT_NTFY_TOPIC;

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousTopic === undefined) delete process.env.BACKUP_ALERT_NTFY_TOPIC;
    else process.env.BACKUP_ALERT_NTFY_TOPIC = previousTopic;
  });

  it("alerta projeto acima do limite e respeita o cooldown", async () => {
    process.env.BACKUP_ALERT_NTFY_TOPIC = "topico-teste";
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const repository = {
      findAll: async () => [{ id: "proj-1", name: "Projeto 1", diskLimitMb: 100 }],
    } as unknown as ProjectRepository;
    const diskUsage = {
      getUsageMb: async () => 150,
    } as unknown as ProjectDiskUsageService;
    const scheduler = new DiskUsageAlertScheduler(repository, diskUsage);

    await scheduler.check();
    await scheduler.check();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não consulta nem alerta sem tópico configurado", async () => {
    delete process.env.BACKUP_ALERT_NTFY_TOPIC;
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const findAll = jest.fn(async () => []);
    const scheduler = new DiskUsageAlertScheduler(
      { findAll } as unknown as ProjectRepository,
      { getUsageMb: async () => 150 } as unknown as ProjectDiskUsageService,
    );

    await scheduler.check();

    expect(findAll).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
