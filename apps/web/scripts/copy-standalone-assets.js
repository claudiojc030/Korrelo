const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const standaloneWeb = path.join(root, ".next", "standalone", "apps", "web");

fs.cpSync(path.join(root, ".next", "static"), path.join(standaloneWeb, ".next", "static"), { recursive: true });

const publicDir = path.join(root, "public");
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(standaloneWeb, "public"), { recursive: true });
}
