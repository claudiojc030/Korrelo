import type { NextFunction, Request, Response } from "express";
import { apiError } from "./api-error";

/**
 * DEFESA ADICIONAL CONTRA CVE-2026-111497 (Brotli decoder do Node.js).
 *
 * O body-parser do Express 5 descomprime `Content-Encoding: br` por padrão
 * (raw-body usa `zlib.createBrotliDecompress`). Numa runtime ainda vulnerável,
 * um corpo Brotli malformado alcança o decoder nativo antes de qualquer
 * validação da aplicação.
 *
 * O Korrelo NÃO usa corpo Brotli: o painel fala JSON puro (eventualmente gzip
 * atrás de proxy). Então a política aqui é REJEITAR antes do parsing:
 *
 *   identity | gzip | deflate  -> segue
 *   br | zstd | desconhecido   -> 415 sem ler/descomprimir o corpo
 *
 * Isso NÃO substitui a atualização do Node.js: é a segunda camada (o decoder
 * também é alcançável por `fetch()` de respostas externas). Ver
 * docs/security/node22-migration.md.
 */
const ALLOWED_CONTENT_ENCODINGS = new Set(["identity", "gzip", "deflate"]);

export function rejectUnsupportedContentEncoding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers["content-encoding"];
  if (!header) {
    next();
    return;
  }

  const encodings = String(header)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const unsupported = encodings.filter((encoding) => !ALLOWED_CONTENT_ENCODINGS.has(encoding));
  if (unsupported.length === 0) {
    next();
    return;
  }

  res
    .status(415)
    .json(
      apiError(
        "UNSUPPORTED_CONTENT_ENCODING",
        `Content-Encoding não suportado: ${unsupported.join(", ")}. ` +
          "Envie o corpo sem compressão (ou com gzip/deflate).",
      ),
    );
}
