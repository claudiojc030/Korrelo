import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import * as express from "express";
import { AppModule } from "./app.module";

function getAllowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGINS;
  if (configured) {
    return configured.split(",").map((origin) => origin.trim());
  }
  const webUrl = process.env.KORRELO_WEB_URL ?? "http://localhost:3000";
  return [webUrl];
}

async function bootstrap() {
  // bodyParser desligado aqui pra poder guardar o corpo bruto da requisição
  // (necessário pra verificar a assinatura HMAC dos webhooks do GitHub,
  // ver github-webhook.controller.ts).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // Atrás do nginx (reverse proxy da VPS), precisa confiar no cabeçalho
  // X-Forwarded-Proto pra saber que a conexão original é https.
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  const allowedOrigins = getAllowedOrigins();
  app.enableCors({
    // Cookie httpOnly de autenticação exige origem explícita (não dá pra usar
    // "*" junto com credentials: true).
    origin: allowedOrigins,
    credentials: true,
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`[korrelo-api] listening on port ${port}`);
}

bootstrap();
