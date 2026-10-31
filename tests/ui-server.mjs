import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oi-ui-test-"));
await fs.cp(
  new URL("./fixtures/notes/", import.meta.url),
  path.join(dataDir, "notes"),
  { recursive: true },
);
process.argv.push("--production");
const app = await createApp({ dataDir });
const server = app.listen(3101, "127.0.0.1");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  app.locals.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
