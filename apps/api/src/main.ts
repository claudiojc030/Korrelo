import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.enableCors();
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`[forgedesk-api] listening on port ${port}`);
}

bootstrap();
