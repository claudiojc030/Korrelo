import { ProjectsController } from "./projects.controller";

/**
 * Contrato do 202 do deploy manual: o painel precisa saber se um job NOVO foi
 * criado e se ele ficou adiado pelo drain. Antes, a resposta era sempre
 * `{ ok: true }` e um clique engolido por job pausado parecia sucesso.
 */
describe("POST /projects/:id/deploy — resposta 202", () => {
  function callDeploy(enqueueResult: unknown) {
    const context = {
      getProject: { execute: async () => ({ id: "proj-1", deployBranch: "master" }) },
      deployQueue: { enqueue: async () => enqueueResult },
    };
    return ProjectsController.prototype.deploy.call(context as never, "proj-1");
  }

  it("informa created=true quando o job é novo", async () => {
    const body = await callDeploy({
      job: { id: "job-novo", status: "queued" },
      created: true,
      deferred: false,
    });
    expect(body).toEqual({
      ok: true,
      jobId: "job-novo",
      status: "queued",
      created: true,
      deferred: false,
    });
  });

  it("informa created=false quando deduplica com job já aberto", async () => {
    const body = await callDeploy({
      job: { id: "job-existente", status: "queued" },
      created: false,
    });
    expect(body.created).toBe(false);
    expect(body.jobId).toBe("job-existente");
    expect(body.deferred).toBe(false);
  });

  it("informa deferred=true quando o worker está em drain", async () => {
    const body = await callDeploy({
      job: { id: "job-drain", status: "queued" },
      created: true,
      deferred: true,
    });
    expect(body.deferred).toBe(true);
    expect(body.created).toBe(true);
  });
});
