import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

// VACUUM INTO captures committed WAL data while the source service stays online.
const source = path.resolve(process.argv[2] || "data");
const target = path.resolve(process.argv[3] || "");
if (!process.argv[3] || source === target)
  throw new Error(
    "Usage: node deploy/snapshot.mjs <data-directory> <new-snapshot-directory>",
  );
await fs.mkdir(target); // Refuse to overwrite an existing backup.
const db = new DatabaseSync(path.join(source, "workspace.sqlite"));
try {
  db.exec("PRAGMA busy_timeout = 10000");
  db.prepare("VACUUM INTO ?").run(path.join(target, "workspace.sqlite"));
} finally {
  db.close();
}
await fs.cp(path.join(source, "notes"), path.join(target, "notes"), {
  recursive: true,
});
const snapshot = new DatabaseSync(path.join(target, "workspace.sqlite"), {
  readOnly: true,
});
try {
  console.log(
    JSON.stringify({
      integrity: snapshot.prepare("PRAGMA integrity_check").get(),
      counts: Object.fromEntries(
        ["users", "sessions", "chats", "messages", "settings"].map((table) => [
          table,
          snapshot.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            .count,
        ]),
      ),
    }),
  );
} finally {
  snapshot.close();
}
