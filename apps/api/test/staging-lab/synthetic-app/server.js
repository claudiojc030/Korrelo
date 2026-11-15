const http = require("node:http");
const { MongoClient } = require("mongodb");

const mode = process.env.APP_MODE ?? "healthy";
const mongoUrl = process.env.MONGO_URL ?? "";
const mongoRequired = process.env.MONGO_REQUIRED === "true";

if (mode === "crash") {
  console.error("staging-lab: crash mode, saindo sem servir health");
  process.exit(1);
}

let client = null;
let database = null;
let dbReady = false;
let dbError = "não conectado";

async function connectMongo() {
  if (!mongoUrl) {
    dbError = "MONGO_URL ausente";
    if (mongoRequired) {
      console.error("staging-lab: MONGO_URL ausente e obrigatório");
      process.exit(2);
    }
    return;
  }
  client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 2000 });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await client.connect();
      database = client.db();
      await database.command({ ping: 1 });
      dbReady = true;
      dbError = "";
      return;
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (mongoRequired) {
    console.error(`staging-lab: falha ao conectar no Mongo: ${dbError}`);
    process.exit(3);
  }
}

async function dbRoundTrip() {
  if (!dbReady || !database) return { ok: false, error: dbError };
  try {
    const collection = database.collection("lab_checks");
    const marker = `check-${Date.now()}`;
    await collection.insertOne({ marker, at: new Date() });
    const found = await collection.findOne({ marker });
    return { ok: Boolean(found), marker, count: await collection.countDocuments() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    if (mode === "unhealthy") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("unhealthy");
      return;
    }
    if (mongoRequired) {
      const roundTrip = await dbRoundTrip();
      response.writeHead(roundTrip.ok ? 200 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify(roundTrip));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.url === "/db") {
    const roundTrip = await dbRoundTrip();
    response.writeHead(roundTrip.ok ? 200 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify(roundTrip));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

connectMongo().then(() => {
  server.listen(3000, "0.0.0.0", () => {
    console.log(`staging-lab synthetic app listening on 3000 (mode=${mode}, mongo=${mongoUrl ? "sim" : "não"})`);
  });
});
