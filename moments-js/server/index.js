// Entry point: loads .env (if present), opens the data store and starts the server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { Store } = await import("./store.js");
const { createApp } = await import("./app.js");

const store = new Store(process.env.DATA_FILE || path.join(ROOT, "data", "db.json"));
const port = Number(process.env.PORT || 8000);
createApp(store).listen(port, () => console.log(`Moments running on http://localhost:${port}`));
