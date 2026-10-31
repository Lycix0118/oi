import "dotenv/config";
import express from "express";
import compression from "compression";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { openDatabase } from "./database.mjs";
import { validImages, modelContent } from "./images.mjs";
import {
  credentials,
  hashPassword,
  verifyPassword,
  readSession,
  tokenHash,
  setSessionCookie,
  sessionLifetime,
} from "./auth.mjs";
import {
  atomicWrite,
  notePath,
  folderPath,
  listNotes,
  listFolders,
  fileTools,
  executeTool,
} from "./storage.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function createApp({
  dataDir = process.env.OI_DATA_DIR || path.join(projectRoot, "data"),
  fetchImpl = fetch,
  trustProxy = process.env.OI_TRUST_PROXY === "loopback" ? "loopback" : false,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    compression({
      filter: (req, res) =>
        req.path !== "/api/chat" && compression.filter(req, res),
    }),
  );
  app.set("trust proxy", trustProxy);
  const database = await openDatabase(dataDir);
  app.locals.close = () => database.close();
  const notesRoot = path.join(dataDir, "notes");
  const noteIndex = new Map();
  await fs.mkdir(notesRoot, { recursive: true });
  app.use(express.json({ limit: "32mb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin) {
      try {
        const u = new URL(origin);
        if (
          u.host !== req.get("host") ||
          !["http:", "https:"].includes(u.protocol)
        )
          return res.status(403).json({ error: "不允许跨站请求" });
      } catch {
        return res.status(403).json({ error: "无效的请求来源" });
      }
    }
    next();
  });
  function config(userId) {
    const stored = database.settings(userId);
    return {
      baseUrl: stored.baseUrl || process.env.AI_BASE_URL || "",
      model: stored.model || process.env.AI_MODEL || "",
      apiKey: stored.apiKey || process.env.AI_API_KEY || "",
      reasoningEffort: stored.reasoningEffort || "default",
    };
  }
  const route = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  app.get("/api/health", (_, res) => res.json({ ok: true }));
  app.get("/api/auth/me", (req, res) => {
    const hash = readSession(req);
    res.json({ user: hash ? database.session(hash) || null : null });
  });
  const attempts = new Map();
  const authLimit = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const key = req.ip;
    const attempt = attempts.get(key) || {
      count: 0,
      until: now + 15 * 60 * 1000,
    };
    attempts.set(key, attempt);
    if (++attempt.count > 30) {
      res.setHeader("Retry-After", Math.ceil((attempt.until - now) / 1000));
      return res.status(429).json({ error: "尝试次数过多，请稍后再试" });
    }
    next();
  };
  function loginSession(req, res, user) {
    const previous = readSession(req);
    if (previous) database.deleteSession(previous);
    const token = crypto.randomBytes(32).toString("hex");
    database.createSession(
      user.id,
      tokenHash(token),
      Date.now() + sessionLifetime,
    );
    setSessionCookie(req, res, token);
    res.json({ user: { id: user.id, username: user.username } });
  }
  app.post(
    "/api/auth/register",
    authLimit,
    route(async (req, res) => {
      const { username, key, password } = credentials(req.body);
      if (database.findUser(key))
        return res.status(409).json({ error: "用户名已被使用" });
      const hash = await hashPassword(password);
      // Recheck after the asynchronous hash to handle simultaneous registrations.
      if (database.findUser(key))
        return res.status(409).json({ error: "用户名已被使用" });
      const user = database.createUser(username, key, hash);
      res.status(201);
      loginSession(req, res, user);
    }),
  );
  app.post(
    "/api/auth/login",
    authLimit,
    route(async (req, res) => {
      const { key, password } = credentials(req.body);
      const user = database.findUser(key);
      const valid = await verifyPassword(password, user?.password_hash);
      if (!user || !valid)
        return res.status(401).json({ error: "用户名或密码不正确" });
      loginSession(req, res, user);
    }),
  );
  app.post("/api/auth/logout", (req, res) => {
    const hash = readSession(req);
    if (hash) database.deleteSession(hash);
    setSessionCookie(req, res, "", 0);
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    const hash = readSession(req);
    req.user = hash ? database.session(hash) : null;
    if (!req.user) return res.status(401).json({ error: "请先登录或注册" });
    if (req.get("X-OI-User") && req.get("X-OI-User") !== req.user.id)
      return res.status(401).json({ error: "当前账号已变化，请重新登录" });
    next();
  });
  app.get(
    "/api/settings",
    route(async (req, res) => {
      const c = config(req.user.id);
      res.json({
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: "",
        hasKey: !!c.apiKey,
        reasoningEffort: c.reasoningEffort,
      });
    }),
  );
  app.put(
    "/api/settings",
    route(async (req, res) => {
      const { baseUrl, model, apiKey } = req.body;
      const url = new URL(baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("请输入有效的 HTTP(S) 接口地址");
      if (typeof model !== "string" || !model.trim() || model.length > 200)
        throw new Error("请输入模型名称");
      if (typeof apiKey !== "string" || apiKey.length > 4096)
        throw new Error("API Key 格式无效");
      const previous = config(req.user.id);
      database.updateSettings(req.user.id, {
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        model: model.trim(),
        apiKey: apiKey || previous.apiKey,
      });
      res.json({ ok: true });
    }),
  );
  app.patch(
    "/api/settings",
    route(async (req, res) => {
      const { reasoningEffort } = req.body;
      if (!["default", "low", "medium", "high"].includes(reasoningEffort))
        throw new Error("无效的思考强度");
      database.updateSettings(req.user.id, { reasoningEffort });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/notes",
    route(async (_, res) => res.json(await listNotes(notesRoot, noteIndex))),
  );
  app.get(
    "/api/library",
    route(async (_, res) => {
      const [notes, folders] = await Promise.all([
        listNotes(notesRoot, noteIndex),
        listFolders(notesRoot),
      ]);
      res.json({ notes, folders });
    }),
  );
  app.get(
    "/api/folders",
    route(async (_, res) => res.json(await listFolders(notesRoot))),
  );
  app.post(
    "/api/folder",
    route(async (req, res) => {
      const folder = await folderPath(notesRoot, req.body.path);
      try {
        await fs.mkdir(folder);
      } catch (error) {
        if (error.code === "EEXIST")
          return res.status(409).json({ error: "同名文件或文件夹已存在" });
        if (error.code === "ENOENT")
          throw new Error("上级文件夹不存在，请先创建上级文件夹");
        throw error;
      }
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/folder/rename",
    route(async (req, res) => {
      const source = await folderPath(notesRoot, req.body.path);
      const target = await folderPath(notesRoot, req.body.newPath);
      if (target.startsWith(source + path.sep))
        throw new Error("不能将文件夹移动到自身或其子文件夹中");
      try {
        await fs.access(target);
        return res.status(409).json({ error: "目标文件或文件夹已存在" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/folder",
    route(async (req, res) => {
      await fs.rm(await folderPath(notesRoot, req.query.path), {
        recursive: true,
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/note",
    route(async (req, res) => {
      const file = await notePath(notesRoot, req.query.path);
      res.json({ content: await fs.readFile(file, "utf8") });
    }),
  );
  app.put(
    "/api/note",
    route(async (req, res) => {
      const file = await notePath(notesRoot, req.body.path);
      if (
        typeof req.body.content !== "string" ||
        req.body.content.length > 500000
      )
        throw new Error("文件内容无效或过大");
      try {
        await atomicWrite(file, req.body.content, {
          createOnly: !!req.body.createOnly,
        });
      } catch (error) {
        if (error.code === "EEXIST")
          return res
            .status(409)
            .json({ error: "同名文件已存在，请更换文件名" });
        throw error;
      }
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/note/rename",
    route(async (req, res) => {
      const source = await notePath(notesRoot, req.body.path);
      const target = await notePath(notesRoot, req.body.newPath);
      try {
        await fs.access(target);
        return res.status(409).json({ error: "目标文件已存在" });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/note",
    route(async (req, res) => {
      await fs.unlink(await notePath(notesRoot, req.body.path));
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/chats",
    route(async (req, res) =>
      res.json(
        database.listChats(req.user.id, { summary: req.query.summary === "1" }),
      ),
    ),
  );
  app.get(
    "/api/chats/:id",
    route(async (req, res) => {
      const chat = database.getChat(req.user.id, req.params.id);
      if (!chat) return res.status(404).json({ error: "对话不存在" });
      res.json(chat);
    }),
  );
  app.put(
    "/api/chats/:id",
    route(async (req, res) => {
      const chat = req.body;
      if (
        chat.id !== req.params.id ||
        !["chat", "agent"].includes(chat.mode) ||
        !Array.isArray(chat.messages) ||
        typeof chat.title !== "string" ||
        chat.title.length > 200 ||
        typeof chat.id !== "string" ||
        chat.id.length > 100 ||
        !chat.id ||
        typeof chat.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(chat.updatedAt)) ||
        chat.messages.length > 1000 ||
        chat.messages.some(
          (m) =>
            !m ||
            typeof m.id !== "string" ||
            m.id.length > 100 ||
            !["user", "assistant"].includes(m.role) ||
            typeof m.content !== "string" ||
            m.content.length > 500000 ||
            !validImages(m.images, m.role) ||
            (m.reasoning !== undefined &&
              (typeof m.reasoning !== "string" ||
                m.reasoning.length > 500000)) ||
            (m.tools !== undefined &&
              (!Array.isArray(m.tools) ||
                m.tools.length > 100 ||
                m.tools.some(
                  (tool) =>
                    !tool ||
                    typeof tool.name !== "string" ||
                    typeof tool.result !== "string" ||
                    tool.result.length > 500000 ||
                    (tool.path !== undefined && typeof tool.path !== "string"),
                ))),
        )
      )
        throw new Error("无效的对话数据");
      database.saveChat(req.user.id, {
        ...chat,
        updatedAt: new Date().toISOString(),
      });
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/chats/:id",
    route(async (req, res) => {
      database.deleteChat(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/chat",
    route(async (req, res) => {
      const c = config(req.user.id);
      if (!c.baseUrl || !c.model || !c.apiKey)
        return res
          .status(400)
          .json({ error: "请先在设置中填写接口地址、模型和 API Key" });
      if (!Array.isArray(req.body.messages) || !req.body.messages.length)
        throw new Error("消息不能为空");
      const messages = req.body.messages.slice(-60).map((m) => {
        if (
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string" ||
          m.content.length > 200000 ||
          !validImages(m.images, m.role)
        )
          throw new Error("无效的对话内容");
        return { role: m.role, content: modelContent(m) };
      });
      const reasoningEffort =
        req.body.reasoningEffort ?? (req.body.thinking ? "high" : "default");
      if (!["default", "low", "medium", "high"].includes(reasoningEffort))
        throw new Error("无效的思考强度");
      const agent = req.body.mode === "agent";
      const savedChat = req.body.chatId
        ? database.getChat(req.user.id, req.body.chatId)
        : null;
      if (
        req.body.chatId &&
        (!savedChat || savedChat.mode !== (agent ? "agent" : "chat"))
      )
        return res.status(404).json({ error: "对话不存在" });
      if (
        savedChat &&
        (typeof req.body.assistantId !== "string" ||
          req.body.assistantId.length > 100)
      )
        throw new Error("无效的消息标识");
      const savedAssistant = {
        id: req.body.assistantId,
        role: "assistant",
        content: "",
        reasoning: "",
        tools: [],
      };
      let lastSaved = 0;
      const saveProgress = (force = false) => {
        if (!savedChat || (!force && Date.now() - lastSaved < 1000)) return;
        // A deleted conversation must not be recreated by an in-flight response.
        if (!database.getChat(req.user.id, savedChat.id)) return;
        lastSaved = Date.now();
        const hasReply =
          savedAssistant.content ||
          savedAssistant.reasoning ||
          savedAssistant.tools.length;
        database.saveChat(req.user.id, {
          ...savedChat,
          updatedAt: new Date().toISOString(),
          messages: [
            ...savedChat.messages,
            ...(hasReply ? [savedAssistant] : []),
          ],
        });
      };
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const send = (event) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": keep-alive\n\n");
      }, 15000);
      try {
        const endpoint =
          c.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") +
          "/chat/completions";
        for (let round = 0; round < 8; round++) {
          const payload = {
            model: c.model,
            messages,
            stream: true,
            ...(reasoningEffort === "default"
              ? {}
              : { reasoning_effort: reasoningEffort }),
            ...(agent ? { tools: fileTools, tool_choice: "auto" } : {}),
          };
          const upstream = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${c.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(180000),
            ]),
          });
          if (!upstream.ok) {
            let detail = "";
            try {
              const body = await upstream.json();
              detail = body.error?.message || "";
            } catch {}
            throw new Error(
              `AI 接口返回 ${upstream.status}${detail ? `：${String(detail).slice(0, 400).replaceAll(c.apiKey, "***")}` : "，请检查地址、模型和密钥"}`,
            );
          }
          if (!upstream.body) throw new Error("AI 接口没有返回响应内容");
          const calls = new Map();
          let content = "";
          let buffer = "";
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          function parseLine(line) {
            if (!line.startsWith("data:")) return;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") return;
            let data;
            try {
              data = JSON.parse(raw);
            } catch {
              return;
            }
            if (data.error)
              throw new Error(data.error.message || "AI 接口响应错误");
            const choice = data.choices?.[0];
            const delta = choice?.delta;
            if (choice?.finish_reason === "length")
              send({
                type: "warning",
                text: "模型输出达到长度限制，可以发送“继续”接着生成。",
              });
            if (delta?.content) {
              content += delta.content;
              savedAssistant.content += delta.content;
              saveProgress();
              send({ type: "delta", text: delta.content });
            }
            if (delta?.reasoning_content) {
              savedAssistant.reasoning += delta.reasoning_content;
              saveProgress();
              send({ type: "reasoning", text: delta.reasoning_content });
            }
            for (const t of delta?.tool_calls || []) {
              const old = calls.get(t.index) || {
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              };
              if (t.id) old.id = t.id;
              if (t.function?.name) old.function.name += t.function.name;
              if (t.function?.arguments)
                old.function.arguments += t.function.arguments;
              calls.set(t.index, old);
            }
          }
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) parseLine(line.replace(/\r$/, ""));
          }
          buffer += decoder.decode();
          if (buffer.trim()) parseLine(buffer.trim());
          if (!calls.size) {
            if (!content)
              throw new Error("模型未返回文字，请检查接口是否支持流式聊天");
            send({ type: "done" });
            return;
          }
          if (!agent) throw new Error("普通聊天不允许调用文件工具");
          const toolCalls = [...calls.values()];
          messages.push({
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls,
          });
          for (const call of toolCalls) {
            if (controller.signal.aborted) return;
            let result;
            let args = {};
            try {
              args = JSON.parse(call.function.arguments);
              if (!args || typeof args !== "object" || Array.isArray(args)) {
                args = {};
                throw new Error("文件操作参数必须是对象");
              }
              result = await executeTool(notesRoot, call.function.name, args);
            } catch (error) {
              result = `操作失败：${error.message}`;
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
            savedAssistant.tools.push({
              name: call.function.name,
              ...(args.path ? { path: args.path } : {}),
              result,
            });
            saveProgress(true);
            send({
              type: "tool",
              name: call.function.name,
              path: args.path,
              result,
            });
          }
          savedAssistant.content += "\n\n";
          send({ type: "delta", text: "\n\n" });
        }
        send({
          type: "error",
          error: "已达到本轮文件操作上限，请发送新消息继续。",
        });
      } catch (error) {
        if (!controller.signal.aborted)
          send({
            type: "error",
            error:
              error.name === "TimeoutError"
                ? "接口响应超时，请重试"
                : error.message,
          });
      } finally {
        clearInterval(heartbeat);
        saveProgress(true);
        res.end();
      }
    }),
  );
  app.use("/api", (_, res) => res.status(404).json({ error: "接口不存在" }));
  if (process.argv.includes("--production")) {
    app.use(
      "/assets",
      express.static(path.join(projectRoot, "dist/assets"), {
        maxAge: "1y",
        immutable: true,
        fallthrough: false,
      }),
    );
    app.use(
      express.static(path.join(projectRoot, "dist"), {
        setHeaders(res, file) {
          if (file.endsWith(".html"))
            res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    app.get("*", (_, res) =>
      res.sendFile(path.join(projectRoot, "dist/index.html")),
    );
  }
  app.use((error, _req, res, _next) => {
    if (!res.headersSent)
      res.status(error.code === "ENOENT" ? 404 : 400).json({
        error:
          error.code === "ENOENT" ? "文件不存在" : error.message || "请求失败",
      });
  });
  return app;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  app.listen(Number(process.env.PORT || 3001), "127.0.0.1", () =>
    console.log(`OI API: http://127.0.0.1:${process.env.PORT || 3001}`),
  );
}
