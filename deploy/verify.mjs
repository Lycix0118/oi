import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] || "data");
const db = new DatabaseSync(path.join(root, "workspace.sqlite"), {
  readOnly: true,
});
const result = {
  integrity: db.prepare("PRAGMA integrity_check").get(),
  tables: {},
  notes: {},
};
try {
  for (const table of ["users", "sessions", "chats", "messages", "settings"]) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    result.tables[table] = {
      count: rows.length,
      sha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(rows))
        .digest("hex"),
    };
  }
} finally {
  db.close();
}
async function scan(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (entry.isFile())
      result.notes[
        path.relative(path.join(root, "notes"), file).replaceAll("\\", "/")
      ] = crypto
        .createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
  }
}
await scan(path.join(root, "notes"));
console.log(JSON.stringify(result));
