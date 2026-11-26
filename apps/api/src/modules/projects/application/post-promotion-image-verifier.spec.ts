import {
  DEFAULT_PRODUCTION_IMAGE_TIMEOUT_MS,
  verifyProductionImage,
} from "./post-promotion-image-verifier";

const EXPECTED = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms: number) => {
      value += ms;
    },
  };
}

describe("verifyProductionImage (pós-promoção)", () => {
  it("aceita a imagem correta imediatamente, sem esperar", async () => {
    const c = clock();
    const inspect = jest.fn().mockResolvedValue(EXPECTED);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ kind: "correct", imageId: EXPECTED });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("espera o container aparecer e aceita a imagem correta após atraso", async () => {
    const c = clock();
    const inspect = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(EXPECTED);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ kind: "correct", imageId: EXPECTED });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(result.waitedMs).toBe(20);
  });

  it("imagem diferente dispara falha imediata, sem aguardar timeout", async () => {
    const c = clock();
    const inspect = jest.fn().mockResolvedValue(OTHER);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ kind: "incorrect", imageId: OTHER });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("timeout sem container aparece como indisponível, nunca sucesso", async () => {
    const c = clock();
    const inspect = jest.fn().mockResolvedValue(null);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 35,
    });

    expect(result.kind).toBe("unavailable");
    expect((result as { reason: string }).reason).toContain("imagem legível");
  });

  it("falha de inspeção nunca vira sucesso", async () => {
    const c = clock();
    const inspect = jest.fn().mockRejectedValue(new Error("docker indisponível"));

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 30,
    });

    expect(result.kind).toBe("unavailable");
    expect((result as { reason: string }).reason).toContain("docker indisponível");
  });

  it("recupera quando a inspeção falha e depois lê a imagem correta", async () => {
    const c = clock();
    const inspect = jest
      .fn()
      .mockRejectedValueOnce(new Error("transitório"))
      .mockResolvedValue(EXPECTED);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 10,
      timeoutMs: 100,
    });

    expect(result.kind).toBe("correct");
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("usa timeout padrão limitado quando não informado", async () => {
    const c = clock();
    const inspect = jest.fn().mockResolvedValue(null);

    const result = await verifyProductionImage({
      expectedImageId: EXPECTED,
      inspect,
      now: c.now,
      sleep: c.sleep,
      intervalMs: 5_000,
    });

    expect(result.kind).toBe("unavailable");
    expect(result.waitedMs).toBeGreaterThanOrEqual(DEFAULT_PRODUCTION_IMAGE_TIMEOUT_MS);
  });
});
