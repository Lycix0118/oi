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
      `INSERT INTO chats VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET title=excluded.title, mode=excluded.mode, updated_at=excluded.updated_at`,
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
    saveChat: (userId, chat) => transaction(() => writeChat(userId, chat)),
    deleteChat: (userId, id) =>
      db
        .prepare("DELETE FROM chats WHERE user_id = ? AND id = ?")
        .run(userId, id),
  };
}
