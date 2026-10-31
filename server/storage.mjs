import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function atomicWrite(file, text, { createOnly = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, "utf8");
    // Linking a complete temporary file is atomic and fails if the target exists.
    if (createOnly) await fs.link(temp, file);
    else await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function notePath(root, input) {
  if (typeof input !== "string" || !input.trim() || input.length > 240)
    throw new Error("请输入有效的文件路径");
  const parts = input.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p.startsWith(".") ||
        /[<>:"|?*\x00-\x1f]/.test(p) ||
        /[ .]$/.test(p) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
    )
  )
    throw new Error("文件路径包含不允许的字符");
  if (!input.toLowerCase().endsWith(".md"))
    throw new Error("知识库仅支持 .md 文件");
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(path.resolve(root) + path.sep))
    throw new Error("文件必须位于知识库目录内");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("不允许访问符号链接");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return full;
}

export async function folderPath(root, input, allowRoot = false) {
  if (allowRoot && input === "") return path.resolve(root);
  if (typeof input !== "string" || !input.trim() || input.length > 240)
    throw new Error("请输入有效的文件夹路径");
  const parts = input.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.startsWith(".") ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
    )
  )
    throw new Error("文件夹路径包含不允许的字符");
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(path.resolve(root) + path.sep))
    throw new Error("文件夹必须位于知识库目录内");
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("不允许访问符号链接");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return full;
}

export async function listFolders(root) {
  const folders = [];
  async function walk(dir, relative = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        entry.isSymbolicLink() ||
        !entry.isDirectory()
      )
        continue;
      const current = relative ? `${relative}/${entry.name}` : entry.name;
      folders.push(current);
      await walk(path.join(dir, entry.name), current);
    }
  }
  await walk(root);
  return folders.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export async function listNotes(root, cache = new Map()) {
  const notes = [];
  const seen = new Set();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const stat = await fs.stat(file);
        seen.add(file);
        const cached = cache.get(file);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.ctimeMs === stat.ctimeMs &&
          cached.note.size === stat.size
        ) {
          notes.push(cached.note);
          continue;
        }
        const content = await fs.readFile(file, "utf8");
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
        notes.push({
          path: path.relative(root, file).replaceAll("\\", "/"),
          title:
            body.match(/^#\s+(.+)/m)?.[1] || entry.name.replace(/\.md$/, ""),
          excerpt:
            body
              .split("\n")
              .filter((x) => x.trim() && !x.startsWith("#"))[0]
              ?.slice(0, 110) || "",
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
        cache.set(file, {
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          note: notes.at(-1),
        });
      }
    }
  }
  await walk(root);
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  return notes.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

export const fileTools = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出所有用户共享的知识库中的 Markdown 文件路径和标题。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取知识库中指定 Markdown 文件，修改前请先读取。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "知识库相对路径，例如 基础算法/二分查找.md",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "创建或完整更新 Markdown 文件。子目录自动创建。文件正文应为 Markdown。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "替换 Markdown 文件中唯一匹配的一段原文，适合局部修改。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeTool(root, name, args) {
  if (name === "list_files") return JSON.stringify(await listNotes(root));
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("文件操作参数必须是对象");
  if (!["read_file", "write_file", "edit_file"].includes(name))
    throw new Error("不支持此文件操作");
  const file = await notePath(root, args.path);
  if (name === "read_file") {
    const content = await fs.readFile(file, "utf8");
    if (content.length > 150000)
      throw new Error("文件过大，请拆分文章后再读取");
    return content;
  }
  let content = args.content;
  if (name === "edit_file") {
    const previous = await fs.readFile(file, "utf8");
    if (
      typeof args.old_text !== "string" ||
      !args.old_text ||
      typeof args.new_text !== "string"
    )
      throw new Error("需要有效的替换文本");
    if (previous.split(args.old_text).length !== 2)
      throw new Error("原文必须恰好匹配一处，请读取文件并提供更精确的片段");
    content = previous.replace(args.old_text, () => args.new_text);
  }
  if (typeof content !== "string" || content.length > 500000)
    throw new Error("文章正文无效或超过 500,000 字符");
  await atomicWrite(file, content);
  return `已保存 ${args.path}`;
}
