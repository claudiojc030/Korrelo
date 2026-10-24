import express = require("express");
import request = require("supertest");
import { rejectUnsupportedContentEncoding } from "./request-encoding";

/**
 * DEFESA ADICIONAL — CVE-2026-111497 (Brotli).
 *
 * O middleware precisa recusar `Content-Encoding: br` (e qualquer encoding
 * fora de identity/gzip/deflate) ANTES do body-parser, sem alterar o
 * comportamento de JSON puro ou gzip — que é o que o painel usa.
 */
describe("rejectUnsupportedContentEncoding", () => {
  function unit(reqHeaders: Record<string, string>) {
    const req = { headers: reqHeaders } as any;
    const res = {
      statusCode: 0,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    let nextCalled = false;
    rejectUnsupportedContentEncoding(req, res as any, () => {
      nextCalled = true;
    });
    return { res, nextCalled };
  }

  it("deixa passar sem Content-Encoding", () => {
    const { res, nextCalled } = unit({});
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it("deixa passar identity, gzip e deflate", () => {
    for (const encoding of ["identity", "gzip", "deflate", "gzip, identity"]) {
      const { nextCalled } = unit({ "content-encoding": encoding });
      expect(nextCalled).toBe(true);
    }
  });

  it("recusa br com 415 sem chamar next", () => {
    const { res, nextCalled } = unit({ "content-encoding": "br" });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(415);
    expect((res.body as any).code).toBe("UNSUPPORTED_CONTENT_ENCODING");
  });

  it("recusa br mesmo combinado com gzip e recusa zstd", () => {
    expect(unit({ "content-encoding": "gzip, br" }).nextCalled).toBe(false);
    expect(unit({ "content-encoding": "BR" }).nextCalled).toBe(false);
    expect(unit({ "content-encoding": "zstd" }).nextCalled).toBe(false);
  });

  describe("integração com o body-parser (Express 5)", () => {
    function buildApp() {
      // Mesma ordem do main.ts: middleware ANTES dos parsers.
      const app = express();
      app.use(rejectUnsupportedContentEncoding);
      app.use(express.json());
      app.post("/echo", (req, res) => res.json({ ok: true, body: req.body }));
      return app;
    }

    it("JSON puro continua funcionando", async () => {
      await request(buildApp())
        .post("/echo")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ a: 1 }))
        .expect(200, { ok: true, body: { a: 1 } });
    });

    it("corpo br é recusado ANTES de qualquer descompressão", async () => {
      // Bytes inválidos de propósito: se o middleware não agisse, o parser
      // tentaria descomprimir. Aqui ele nem é chamado.
      const response = await request(buildApp())
        .post("/echo")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "br")
        .send(Buffer.from([0x00, 0x01, 0x02, 0x03]));

      expect(response.status).toBe(415);
      expect(response.body.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
    });
  });
});
