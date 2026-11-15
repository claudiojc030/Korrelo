const http = require("node:http");

const mode = process.env.APP_MODE ?? "healthy";

if (mode === "crash") {
  console.error("staging-lab: crash mode, saindo sem servir health");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    if (mode === "unhealthy") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("unhealthy");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(3000, "0.0.0.0", () => {
  console.log(`staging-lab synthetic app listening on 3000 (mode=${mode})`);
});
