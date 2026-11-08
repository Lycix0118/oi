import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function openDatabase(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS chats (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL, title TEXT NOT NULL, mode TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT NOT NULL, chat_id TEXT NOT NULL, position INTEGER NOT NULL,
      id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT, tools TEXT, PRIMARY KEY (user_id, chat_id, position),
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS chats_updated ON chats(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  if (
    !db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((column) => column.name === "images")
  )
    db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(chats)")
      .all()
      .some((c) => c.name === "revision")
  )
    db.exec("ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS generations (user_id TEXT NOT NULL, chat_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(user_id, chat_id), FOREIGN KEY(user_id, chat_id) REFERENCES chats(user_id,id) ON DELETE CASCADE)",
  );
  db.prepare(
    "UPDATE generations SET state = ? WHERE json_extract(state, '$.status') = 'running'",
  ).run(
    JSON.stringify({
      status: "interrupted",
      error: "服务器已重启，任务中断，请重新生成",
    }),
  );
  function setGeneration(userId, chatId, state) {
    db.prepare(
      "INSERT INTO generations VALUES (?, ?, ?) ON CONFLICT(user_id,chat_id) DO UPDATE SET state=excluded.state",
    ).run(userId, chatId, JSON.stringify(state));
  }
  function getChat(userId, id) {
    const row = db
      .prepare("SELECT * FROM chats WHERE user_id = ? AND id = ?")
      .get(userId, id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      updatedAt: row.updated_at,
      revision: row.revision,
      generation: JSON.parse(
        db
          .prepare(
            "SELECT state FROM generations WHERE user_id=? AND chat_id=?",
          )
          .get(userId, id)?.state || "null",
      ),
      messages: db
        .prepare(
          "SELECT * FROM messages WHERE user_id = ? AND chat_id = ? ORDER BY position",
        )
        .all(userId, id)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ...(m.images === null ? {} : { images: JSON.parse(m.images) }),
          ...(m.reasoning === null ? {} : { reasoning: m.reasoning }),
          ...(m.tools === null ? {} : { tools: JSON.parse(m.tools) }),
        })),
    };
  }
  function writeChat(userId, chat) {
    db.prepare(
      `INSERT INTO chats (user_id, id, title, mode, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET title=excluded.title, mode=excluded.mode, updated_at=excluded.updated_at, revision=chats.revision+1`,
    ).run(userId, chat.id, chat.title, chat.mode, chat.updatedAt);
    db.prepare("DELETE FROM messages WHERE user_id = ? AND chat_id = ?").run(
      userId,
      chat.id,
    );
    const insert = db.prepare(
      "INSERT INTO messages (user_id, chat_id, position, id, role, content, reasoning, tools, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    chat.messages.forEach((m, i) =>
      insert.run(
        userId,
        chat.id,
        i,
        m.id,
        m.role,
        m.content,
        m.reasoning ?? null,
        m.tools === undefined ? null : JSON.stringify(m.tools),
        m.images === undefined ? null : JSON.stringify(m.images),
      ),
    );
  }
  function settings(userId) {
    const row = db
      .prepare("SELECT config FROM settings WHERE user_id = ?")
      .get(userId);
    return row ? JSON.parse(row.config) : {};
  }
  function updateSettings(userId, values) {
    const next = { ...settings(userId), ...values };
    db.prepare(
      `INSERT INTO settings VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET config=excluded.config`,
    ).run(userId, JSON.stringify(next));
    return next;
  }
  return {
    close: () => db.close(),
    findUser: (key) =>
      db.prepare("SELECT * FROM users WHERE username_key = ?").get(key),
    createUser(username, key, passwordHash) {
      return transaction(() => {
        const user = { id: crypto.randomUUID(), username };
        db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
          user.id,
          username,
          key,
          passwordHash,
          new Date().toISOString(),
        );
        return user;
      });
    },
    createSession(userId, tokenHash, expiresAt) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
        tokenHash,
        userId,
        expiresAt,
      );
    },
    session(tokenHash) {
      return db
        .prepare(
          `SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE token_hash = ? AND expires_at > ?`,
        )
        .get(tokenHash, Date.now());
    },
    deleteSession: (hash) =>
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash),
    settings,
    updateSettings,
    getChat,
    setGeneration,
    chatPage(userId, { before, limit = 30, query = "" } = {}) {
      const cursor = before
        ? JSON.parse(Buffer.from(before, "base64url").toString())
        : null;
      if (
        cursor &&
        (!Array.isArray(cursor) ||
          cursor.length !== 2 ||
          cursor.some((v) => typeof v !== "string"))
      )
        throw new Error("无效的分页游标");
      const rows = db
        .prepare(
          "SELECT id,title,mode,updated_at AS updatedAt FROM chats WHERE user_id=? AND instr(lower(title),lower(?))>0 AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT ?",
        )
        .all(
          userId,
          query,
          cursor?.[0] ?? null,
          cursor?.[0] ?? "",
          cursor?.[0] ?? "",
          cursor?.[1] ?? "",
          limit + 1,
        );
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > limit
            ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString(
                "base64url",
              )
            : null,
      };
    },
    listChats(userId, { summary = false } = {}) {
      if (summary)
        return db
          .prepare(
            "SELECT id, title, mode, updated_at AS updatedAt FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
          )
          .all(userId);
      return db
        .prepare(
          "SELECT id FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .all(userId)
        .map((row) => getChat(userId, row.id));
    },
    saveChat: (userId, chat) =>
      transaction(() => {
        const current = getChat(userId, chat.id);
        if (!current && chat.revision !== undefined) {
          const error = new Error("对话已被删除，请新建对话");
          error.status = 409;
          throw error;
        }
        if (current && chat.revision !== current.revision) {
          const error = new Error("对话已在其他页面更新，请重新打开对话后再试");
          error.status = 409;
          throw error;
        }
        writeChat(userId, chat);
        return getChat(userId, chat.id);
      }),
    saveAssistant: (userId, chatId, assistant) =>
      transaction(() => {
        if (
          !db
            .prepare("SELECT 1 FROM chats WHERE user_id=? AND id=?")
            .get(userId, chatId)
        )
          return;
        const existing = db
          .prepare(
            "SELECT position FROM messages WHERE user_id=? AND chat_id=? AND id=?",
          )
          .get(userId, chatId, assistant.id);
        if (existing) {
          db.prepare(
            "UPDATE messages SET content=?, reasoning=?, tools=? WHERE user_id=? AND chat_id=? AND position=?",
          ).run(
            assistant.content,
            assistant.reasoning ?? null,
            JSON.stringify(assistant.tools || []),
            userId,
            chatId,
            existing.position,
          );
        } else {
          const position = db
            .prepare(
              "SELECT COALESCE(MAX(position),-1)+1 AS position FROM messages WHERE user_id=? AND chat_id=?",
            )
            .get(userId, chatId).position;
          db.prepare(
            "INSERT INTO messages (user_id,chat_id,position,id,role,content,reasoning,tools) VALUES (?,?,?,?,?,?,?,?)",
          ).run(
            userId,
            chatId,
            position,
            assistant.id,
            "assistant",
            assistant.content,
            assistant.reasoning ?? null,
            JSON.stringify(assistant.tools || []),
          );
        }
        db.prepare(
          "UPDATE chats SET updated_at=?, revision=revision+1 WHERE user_id=? AND id=?",
        ).run(new Date().toISOString(), userId, chatId);
      }),
    deleteChat: (userId, id) =>
      db
        .prepare("DELETE FROM chats WHERE user_id = ? AND id = ?")
        .run(userId, id),
  };
}
