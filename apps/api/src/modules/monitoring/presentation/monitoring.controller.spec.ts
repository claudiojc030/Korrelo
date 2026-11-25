import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MonitoringController } from "./monitoring.controller";
import type { ResourceProfileService } from "../../projects/infrastructure/resource-profile.service";
import type { ProjectRepository } from "../../projects/domain/project.repository";

function controller(
  store: { describe: jest.Mock },
  projects: { findById: jest.Mock } = { findById: jest.fn().mockResolvedValue({ id: "proj-1" }) },
) {
  return new MonitoringController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    store as unknown as ResourceProfileService,
    projects as unknown as ProjectRepository,
  );
}

describe("MonitoringController - resource profiles", () => {
  it("exige projectId", async () => {
    const store = { describe: jest.fn() };
    await expect(controller(store).resourceProfiles(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller(store).resourceProfiles("   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.describe).not.toHaveBeenCalled();
  });

  it("recusa projeto inexistente (autorização por projeto)", async () => {
    const store = { describe: jest.fn() };
    const projects = { findById: jest.fn().mockResolvedValue(null) };

    await expect(controller(store, projects).resourceProfiles("proj-x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(store.describe).not.toHaveBeenCalled();
  });

  it("devolve o painel do projeto exato", async () => {
    const panel = { projectId: "proj-1", profiles: [], message: "Perfil de build ainda não medido." };
    const store = { describe: jest.fn().mockReturnValue(panel) };
    const projects = { findById: jest.fn().mockResolvedValue({ id: "proj-1" }) };

    const result = await controller(store, projects).resourceProfiles(" proj-1 ");

    expect(result).toBe(panel);
    expect(projects.findById).toHaveBeenCalledWith("proj-1");
    expect(store.describe).toHaveBeenCalledWith("proj-1");
  });
});
