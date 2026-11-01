import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { notePath, executeTool, listNotes } from "../server/storage.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  modelProfiles,
  saveModel,
  resolveModel,
  publicSettings,
} from "../server/models.mjs";

test("saving profiles preserves selection and ordering and only falls back when the selected model is removed", async (t) => {
  const { request, restart } = await fixture(t);
  const profile = (id, models) => ({
    id,
    name: id,
    baseUrl: `https://${id}.invalid/v1`,
    apiKey: "secret",
    models,
    model: models[0],
  });
  await request("/settings", "PUT", profile("first", ["fast", "deep"]));
  await request("/settings", "PATCH", {
    activeModelId: "first",
    model: "deep",
  });
  let response = await request(
    "/settings",
    "PUT",
    profile("second", ["other"]),
  );
  assert.equal(response.status, 200);
  let config = await response.json();
  assert.equal(config.activeModelId, "first");
  assert.equal(config.model, "deep");
  response = await request("/settings", "PUT", {
    ...profile("first", ["fast", "deep"]),
    model: "fast",
    apiKey: "",
  });
  config = await response.json();
  assert.equal(config.model, "deep");
  assert.deepEqual(
    config.profiles.map((p) => p.id),
    ["first", "second"],
  );
  await request("/settings", "PUT", {
    ...profile("second", ["other", "extra"]),
    model: "extra",
    apiKey: "",
  });
  await restart();
  config = await (await request("/settings")).json();
  assert.equal(config.model, "deep");
  config = await (
    await request("/settings", "PUT", profile("first", ["fast"]))
  ).json();
  assert.equal(config.model, "fast");
  assert.equal(config.activeModelId, "first");
  config = await (await request("/models/second", "DELETE")).json();
  assert.equal(config.model, "fast");
});

test("stale persisted selections recover while explicit unknown selections remain errors", () => {
  const profiles = [
    {
      id: "personal",
      name: "personal",
      baseUrl: "https://test.invalid/v1",
      models: ["current"],
      model: "current",
      apiKey: "secret",
    },
  ];
  for (const stored of [
    { profiles, activeModelId: "removed", activeModel: "old" },
    { profiles, activeModelId: "personal", activeModel: "removed-model" },
  ]) {
    const config = publicSettings(stored);
    assert.equal(config.activeModelId, "personal");
    assert.equal(config.model, "current");
    assert.ok(!JSON.stringify(config).includes("secret"));
    assert.throws(() => resolveModel(stored, "removed"), /不存在/);
    assert.throws(
      () => resolveModel(stored, "personal", "removed-model"),
      /不在此配置中/,
    );
  }
  assert.equal(
    publicSettings({ profiles: [], activeModelId: "removed" }).model,
    "",
  );
});

test("connection normalization retains credentials only for the same endpoint and blank names support long model IDs", () => {
  const model = "m".repeat(200);
  const stored = saveModel(
    {},
    {
      id: "first",
      name: "",
      baseUrl: " https://EXAMPLE.invalid:443/v1/ ",
      apiKey: " secret ",
      models: [model],
    },
  );
  assert.equal(stored.profiles[0].apiKey, "secret");
  assert.equal(stored.profiles[0].name.length, 100);
  const next = saveModel(stored, {
    id: "first",
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
    models: [model],
  });
  assert.equal(next.profiles[0].apiKey, "secret");
  assert.throws(
    () =>
      saveModel(stored, {
        id: "first",
        baseUrl: "https://other.invalid/v1",
        apiKey: " ",
        models: [model],
      }),
    /填写 API Key/,
  );
  for (const baseUrl of [
    null,
    12,
    "invalid",
    "ftp://example.invalid",
    "https://example.invalid/v1?query=1",
  ]) {
    assert.throws(
      () => saveModel({}, { baseUrl, apiKey: "secret", model: "test" }),
      /有效的 HTTP\(S\)/,
    );
  }
});

test("same conversation rejects overlapping generations and stale saves, and can generate again", async (t) => {
  let finish;
  let count = 0;
  const { request } = await fixture(t, async () => {
    count++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"回复"}}]}\n\n',
            ),
          );
          finish = () => controller.close();
        },
      }),
    );
  });
  await request("/settings", "PUT", {
    baseUrl: "https://test.invalid/v1",
    model: "test",
    apiKey: "secret",
  });
  const chat = {
    id: "race",
    title: "并发",
    mode: "chat",
    updatedAt: new Date().toISOString(),
    messages: [{ id: "q", role: "user", content: "问题" }],
  };
  await request("/chats/race", "PUT", chat);
  const stale = await (await request("/chats/race")).json();
  const body = {
    chatId: "race",
    assistantId: "answer",
    revision: stale.revision,
    messages: chat.messages,
  };
  const response = await request("/chat", "POST", body);
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(
    (await request("/chat", "POST", { ...body, assistantId: "other" })).status,
    409,
  );
  assert.equal((await request("/chats/race", "PUT", stale)).status, 409);
  assert.equal(count, 1);
  finish();
  while (!(await reader.read()).done) {}
  assert.equal((await request("/chats/race", "PUT", stale)).status, 409);
  const latest = await (await request("/chats/race")).json();
  assert.deepEqual(
    latest.messages.map((m) => m.id),
    ["q", "answer"],
  );
  latest.messages.push({ id: "q2", role: "user", content: "新问题" });
  assert.equal((await request("/chats/race", "PUT", latest)).status, 200);
  const next = await (await request("/chats/race")).json();
  const second = await request("/chat", "POST", {
    ...body,
    revision: next.revision,
    assistantId: "answer2",
    messages: next.messages,
  });
  const secondReader = second.body.getReader();
  await secondReader.read();
  finish();
  while (!(await secondReader.read()).done) {}
  const final = await (await request("/chats/race")).json();
  assert.deepEqual(
    final.messages.map((m) => m.id),
    ["q", "answer", "q2", "answer2"],
  );
  await request("/chats/race", "DELETE");
  assert.equal((await request("/chats/race", "PUT", final)).status, 409);
});

test("model profiles switch credentials, persist across restart, and remain private", async (t) => {
  const calls = [];
  const { request, client, restart } = await fixture(t, async (url, init) => {
    calls.push({
      url,
      key: init.headers.Authorization,
      model: JSON.parse(init.body).model,
    });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  });
  for (const id of ["one", "two"]) {
    assert.equal(
      (
        await request("/settings", "PUT", {
          id,
          name: id,
          baseUrl: `https://${id}.invalid/v1`,
          model: id,
          apiKey: `secret-${id}`,
        })
      ).status,
      200,
    );
  }
  let settings = await (await request("/settings")).json();
  assert.equal(settings.profiles.length, 2);
  assert.ok(!JSON.stringify(settings).includes("secret-"));
  assert.equal(settings.activeModelId, "one");
  await request("/settings", "PATCH", { activeModelId: "one" });
  await restart();
  settings = await (await request("/settings")).json();
  assert.equal(settings.activeModelId, "one");
  await (
    await request("/chat", "POST", {
      messages: [{ role: "user", content: "test" }],
    })
  ).text();
  await (
    await request("/chat", "POST", {
      modelId: "two",
      messages: [{ role: "user", content: "test" }],
    })
  ).text();
  assert.deepEqual(calls, [
    {
      url: "https://one.invalid/v1/chat/completions",
      key: "Bearer secret-one",
      model: "one",
    },
    {
      url: "https://two.invalid/v1/chat/completions",
      key: "Bearer secret-two",
      model: "two",
    },
  ]);
  assert.equal(
    (
      await request("/settings", "PUT", {
        id: "one",
        name: "changed",
        baseUrl: "https://one.invalid/v1",
        model: "one-new",
        apiKey: "",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/settings", "PUT", {
        id: "one",
        baseUrl: "https://other.invalid/v1",
        model: "one",
        apiKey: "",
      })
    ).status,
    400,
  );
  const other = client();
  await other("/auth/register", "POST", {
    username: "other-profile",
    password: "test-password",
  });
  assert.equal(
    (await other("/settings", "PATCH", { activeModelId: "two" })).status,
    400,
  );
  assert.equal((await other("/models/two", "DELETE")).status, 400);
  assert.equal((await (await other("/settings")).json()).profiles.length, 0);
  await request("/models/one", "DELETE");
  assert.equal(
    (await (await request("/settings")).json()).activeModelId,
    "two",
  );
  await request("/models/two", "DELETE");
  assert.equal((await (await request("/settings")).json()).profiles.length, 0);
});

test("models within a profile share credentials and persist the selected model", async (t) => {
  const calls = [];
  const { request, restart } = await fixture(t, async (url, init) => {
    calls.push({
      url,
      key: init.headers.Authorization,
      model: JSON.parse(init.body).model,
    });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  });
  const profile = {
    id: "shared",
    name: "共享接口",
    baseUrl: "https://shared.invalid/v1",
    apiKey: "shared-secret",
    models: ["fast", "deep", "fast"],
  };
  assert.equal((await request("/settings", "PUT", profile)).status, 200);
  let settings = await (await request("/settings")).json();
  assert.deepEqual(settings.profiles[0].models, ["fast", "deep"]);
  assert.equal(settings.model, "fast");
  assert.equal(
    (
      await request("/settings", "PATCH", {
        activeModelId: "shared",
        model: "deep",
      })
    ).status,
    200,
  );
  await restart();
  settings = await (await request("/settings")).json();
  assert.equal(settings.model, "deep");
  assert.equal(settings.profiles[0].model, "fast");
  assert.ok(!JSON.stringify(settings).includes("shared-secret"));
  await (
    await request("/chat", "POST", {
      messages: [{ role: "user", content: "test" }],
    })
  ).text();
  await (
    await request("/chat", "POST", {
      modelId: "shared",
      model: "fast",
      messages: [{ role: "user", content: "test" }],
    })
  ).text();
  assert.deepEqual(
    calls.map((c) => c.model),
    ["deep", "fast"],
  );
  assert.ok(calls.every((c) => c.key === "Bearer shared-secret"));
  assert.equal(
    (
      await request("/settings", "PATCH", {
        activeModelId: "shared",
        model: "missing",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/chat", "POST", {
        modelId: "shared",
        model: "missing",
        messages: [{ role: "user", content: "test" }],
      })
    ).status,
    400,
  );
  for (const models of [[], [""], [null], "fast", Array(201).fill("fast")])
    assert.equal(
      (await request("/settings", "PUT", { ...profile, models })).status,
      400,
    );
  assert.equal(
    (await request("/settings", "PUT", { ...profile, model: "missing" }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("/settings", "PUT", {
        ...profile,
        apiKey: "",
        models: ["fast"],
      })
    ).status,
    200,
  );
  assert.equal((await (await request("/settings")).json()).model, "fast");
});

test("model discovery uses saved credentials only for the owning account and endpoint", async (t) => {
  const calls = [];
  let result = {
    data: [
      { id: "z" },
      { id: "a" },
      { id: "z" },
      { id: " a " },
      { id: "" },
      { id: 3 },
      null,
    ],
  };
  let status = 200;
  const { request, client } = await fixture(t, async (url, init) => {
    calls.push({ url, init });
    if (status === 0) throw new Error("private-secret");
    return new Response(
      typeof result === "string" ? result : JSON.stringify(result),
      { status },
    );
  });
  const connection = {
    id: "provider",
    baseUrl: "https://provider.invalid/v1/",
    apiKey: "private-secret",
  };
  assert.deepEqual(
    await (await request("/models/discover", "POST", connection)).json(),
    { models: ["a", "z"] },
  );
  assert.equal((await (await request("/settings")).json()).profiles.length, 0);
  assert.equal(calls[0].url, "https://provider.invalid/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer private-secret");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  await request("/settings", "PUT", { ...connection, model: "a" });
  assert.equal(
    (await request("/models/discover", "POST", { ...connection, apiKey: "" }))
      .status,
    200,
  );
  const count = calls.length;
  assert.equal(
    (
      await request("/models/discover", "POST", {
        ...connection,
        baseUrl: "https://other.invalid/v1",
        apiKey: "",
      })
    ).status,
    400,
  );
  const other = client();
  assert.equal(
    (await other("/models/discover", "POST", connection)).status,
    401,
  );
  await other("/auth/register", "POST", {
    username: "discovery-other",
    password: "test-password",
  });
  assert.equal(
    (await other("/models/discover", "POST", { ...connection, apiKey: "" }))
      .status,
    400,
  );
  assert.equal(calls.length, count);
  for (const [value, code, message] of [
    [{ data: [] }, 200, null],
    [{ models: [] }, 200, "兼容"],
    ["invalid json", 200, "JSON"],
    [{ error: "private-secret" }, 401, "HTTP 401"],
    [{}, 0, "网络"],
  ]) {
    result = value;
    status = code;
    const response = await request("/models/discover", "POST", connection);
    const body = await response.json();
    assert.equal(response.status, message ? 400 : 200);
    if (message) assert.ok(body.error.includes(message));
    else assert.deepEqual(body.models, []);
    assert.ok(!JSON.stringify(body).includes("private-secret"));
  }
});

test("legacy model settings migrate without sharing credentials with a new endpoint", () => {
  const stored = {
    baseUrl: "https://legacy.invalid/v1",
    model: "old",
    apiKey: "old-secret",
  };
  assert.equal(
    modelProfiles(stored).find((p) => p.id === "legacy").apiKey,
    "old-secret",
  );
  assert.throws(
    () =>
      saveModel(stored, {
        id: "new",
        baseUrl: stored.baseUrl,
        model: "new",
        apiKey: "",
      }),
    /API Key/,
  );
  const updated = saveModel(stored, {
    baseUrl: stored.baseUrl,
    model: "updated",
    apiKey: "",
  });
  assert.equal(updated.profiles[0].apiKey, "old-secret");
});

async function fixture(
  t,
  fetchImpl,
  { autoLogin = true, legacy, trustProxy = false } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oi-study-test-"));
  if (legacy) {
    await fs.writeFile(
      path.join(dataDir, "chats.json"),
      JSON.stringify(legacy.chats),
    );
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      JSON.stringify(legacy.settings),
    );
  }
  let app = await createApp({ dataDir, fetchImpl, trustProxy });
  let server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "";
    return async (route, method = "GET", body, options = {}) => {
      const response = await fetch(`${base}${route}`, {
        ...options,
        method,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    };
  }
  const request = client();
  if (autoLogin)
    assert.equal(
      (
        await request("/auth/register", "POST", {
          username: "测试用户",
          password: "test-password",
        })
      ).status,
      201,
    );
  async function restart() {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
    app = await createApp({ dataDir, fetchImpl, trustProxy });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
  }
  return {
    request,
    client,
    restart,
    dataDir,
    root: path.join(dataDir, "notes"),
  };
}

test("local HTTPS proxy sets secure cookies and preserves same-origin checks", async (t) => {
  const { request } = await fixture(t, undefined, {
    autoLogin: false,
    trustProxy: "loopback",
  });
  const host = new URL((await request("/health")).url).host;
  const headers = {
    Origin: `https://${host}`,
    "X-Forwarded-Proto": "https",
    "X-Forwarded-For": "203.0.113.10",
  };
  const response = await request(
    "/auth/register",
    "POST",
    { username: "代理测试", password: "test-password" },
    { headers },
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /; Secure/);
  assert.match(response.headers.get("set-cookie"), /; HttpOnly/);
  assert.equal(
    (await request("/auth/me", "GET", undefined, { headers })).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/auth/login",
        "POST",
        { username: "代理测试", password: "test-password" },
        { headers: { ...headers, Origin: "https://other.example" } },
      )
    ).status,
    403,
  );
});

test("Markdown files persist through create, read, rename and delete; collisions do not overwrite", async (t) => {
  const { request } = await fixture(t);
  const target = "基础算法/二分.md";
  assert.equal(
    (
      await request("/note", "PUT", {
        path: target,
        content: "# 二分\n\n单调性",
        createOnly: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/note", "PUT", {
        path: target,
        content: "overwrite",
        createOnly: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (await (await request(`/note?path=${encodeURIComponent(target)}`)).json())
      .content,
    "# 二分\n\n单调性",
  );
  assert.equal((await (await request("/notes")).json())[0].title, "二分");
  assert.equal(
    (
      await request("/note/rename", "POST", {
        path: target,
        newPath: "算法/二分查找.md",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/note?path=${encodeURIComponent(target)}`)).status,
    404,
  );
  assert.equal(
    (await request("/note", "DELETE", { path: "算法/二分查找.md" })).status,
    200,
  );
  assert.deepEqual(await (await request("/notes")).json(), []);
});

test("authentication requires only username/password and protects all workspace routes", async (t) => {
  const { request, client, dataDir } = await fixture(t, undefined, {
    autoLogin: false,
  });
  assert.deepEqual(await (await request("/auth/me")).json(), { user: null });
  for (const [route, method, body] of [
    ["/settings", "GET"],
    ["/settings", "PUT", {}],
    ["/settings", "PATCH", {}],
    ["/chats", "GET"],
    ["/chats/secret", "GET"],
    ["/chats/secret", "PUT", {}],
    ["/chats/secret", "DELETE"],
    ["/notes", "GET"],
    ["/library", "GET"],
    ["/folders", "GET"],
    ["/note", "PUT", {}],
    ["/folder", "POST", {}],
    ["/chat", "POST", {}],
  ])
    assert.equal((await request(route, method, body)).status, 401, route);
  assert.equal(
    (
      await request("/auth/register", "POST", {
        username: "a",
        password: "123456",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/auth/register", "POST", {
        username: "学生",
        password: "123",
      })
    ).status,
    400,
  );
  const registered = await request("/auth/register", "POST", {
    username: "学生_A",
    password: "correct-password",
  });
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const { user } = await registered.json();
  assert.equal(user.username, "学生_A");
  assert.deepEqual((await (await request("/auth/me")).json()).user, user);
  const other = client();
  assert.equal(
    (
      await other("/auth/register", "POST", {
        username: "学生_a",
        password: "another-password",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await other("/auth/login", "POST", {
        username: "学生_A",
        password: "wrong-password",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await other("/auth/login", "POST", {
        username: "不存在",
        password: "wrong-password",
      })
    ).status,
    401,
  );
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  try {
    const row = db.prepare("SELECT * FROM users").get();
    assert.notEqual(row.password_hash, "correct-password");
    assert.match(row.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    const session = db.prepare("SELECT * FROM sessions").get();
    assert.notEqual(session.token_hash, cookie.split(";")[0].split("=")[1]);
  } finally {
    db.close();
  }
  await request("/auth/logout", "POST");
  assert.equal((await request("/chats")).status, 401);
  const staleCookie = await fetch(
    registered.url.replace("/auth/register", "/chats"),
    { headers: { Cookie: cookie.split(";")[0] } },
  );
  assert.equal(staleCookie.status, 401);
  assert.equal(
    (
      await request("/auth/login", "POST", {
        username: "学生_a",
        password: "correct-password",
      })
    ).status,
    200,
  );
});

test("accounts isolate chats, reasoning, tool results and settings while sharing the same knowledge files", async (t) => {
  const { request: alice, client, restart } = await fixture(t);
  const bob = client();
  await bob("/auth/register", "POST", {
    username: "另一位学生",
    password: "bob-password",
  });
  const chat = {
    id: "private-chat",
    title: "私有题目",
    mode: "agent",
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: "答案",
        reasoning: "思考过程",
        tools: [
          { name: "read_file", path: "shared.md", result: "完整工具结果" },
        ],
      },
    ],
  };
  assert.equal((await alice("/chats/private-chat", "PUT", chat)).status, 200);
  assert.deepEqual(await (await bob("/chats")).json(), []);
  assert.equal((await bob("/chats/private-chat")).status, 404);
  await bob("/chats/private-chat", "DELETE");
  assert.equal((await (await alice("/chats")).json()).length, 1);
  await bob("/chats/private-chat", "PUT", {
    ...chat,
    title: "Bob 的对话",
    messages: [],
  });
  assert.equal(
    (await (await alice("/chats/private-chat")).json()).title,
    "私有题目",
  );
  await alice("/settings", "PUT", {
    baseUrl: "https://alice.test/v1",
    model: "alice-model",
    apiKey: "alice-secret",
  });
  await bob("/settings", "PUT", {
    baseUrl: "https://bob.test/v1",
    model: "bob-model",
    apiKey: "bob-secret",
  });
  await alice("/settings", "PATCH", { reasoningEffort: "high" });
  await bob("/settings", "PATCH", { reasoningEffort: "low" });
  const aliceUser = (await (await alice("/auth/me")).json()).user;
  assert.equal(
    (
      await bob("/settings", "GET", undefined, {
        headers: { "X-OI-User": aliceUser.id },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await bob("/chats/private-chat", "PUT", chat, {
        headers: { "X-OI-User": aliceUser.id },
      })
    ).status,
    401,
  );
  assert.equal(
    (await (await bob("/chats/private-chat")).json()).title,
    "Bob 的对话",
  );
  await alice("/note", "PUT", {
    path: "shared.md",
    content: "# 大家共享\nAlice 创建",
  });
  assert.match(
    (await (await bob("/note?path=shared.md")).json()).content,
    /Alice 创建/,
  );
  await bob("/note", "PUT", {
    path: "shared.md",
    content: "# 大家共享\nBob 编辑",
  });
  assert.match(
    (await (await alice("/note?path=shared.md")).json()).content,
    /Bob 编辑/,
  );
  await restart();
  assert.equal((await alice("/auth/me")).status, 200);
  assert.deepEqual(
    (await (await alice("/chats/private-chat")).json()).messages,
    chat.messages,
  );
  const aliceConfig = await (await alice("/settings")).json();
  const bobConfig = await (await bob("/settings")).json();
  assert.equal(aliceConfig.model, "alice-model");
  assert.equal(aliceConfig.reasoningEffort, "high");
  assert.equal(aliceConfig.apiKey, "");
  assert.equal(bobConfig.model, "bob-model");
  assert.equal(bobConfig.reasoningEffort, "low");
  assert.equal(
    (await (await bob("/chats/private-chat")).json()).title,
    "Bob 的对话",
  );
});

test("every new account starts empty, including the first account and accounts registered after restart", async (t) => {
  const legacy = {
    chats: [
      {
        id: "legacy",
        title: "旧对话",
        mode: "chat",
        messages: [{ id: "old-message", role: "user", content: "旧问题" }],
        updatedAt: new Date().toISOString(),
      },
    ],
    settings: {
      baseUrl: "https://old.test/v1",
      model: "old-model",
      apiKey: "old-key",
    },
  };
  const { request, client, restart, dataDir } = await fixture(t, undefined, {
    legacy,
  });
  const assertEmpty = async (client) => {
    assert.deepEqual(await (await client("/chats")).json(), []);
    assert.deepEqual(await (await client("/settings")).json(), {
      baseUrl: "",
      model: "",
      apiKey: "",
      hasKey: false,
      reasoningEffort: "default",
      activeModelId: "",
      profiles: [],
    });
  };
  await assertEmpty(request);
  await request("/settings", "PUT", {
    baseUrl: "https://first.test/v1",
    model: "first-model",
    apiKey: "first-key",
  });
  await request("/chats/first-chat", "PUT", {
    id: "first-chat",
    title: "首个账号自己的对话",
    mode: "chat",
    messages: [],
    updatedAt: new Date().toISOString(),
  });
  const second = client();
  assert.equal(
    (
      await second("/auth/register", "POST", {
        username: "second",
        password: "second-password",
      })
    ).status,
    201,
  );
  await assertEmpty(second);
  await restart();
  const third = client();
  assert.equal(
    (
      await third("/auth/register", "POST", {
        username: "third",
        password: "third-password",
      })
    ).status,
    201,
  );
  await assertEmpty(third);
  await assertEmpty(second);
  assert.equal(
    (await (await request("/chats")).json())[0].title,
    "首个账号自己的对话",
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataDir, "chats.json"), "utf8")),
    legacy.chats,
  );
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM chats").get().count,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM settings").get().count,
      1,
    );
    for (const client of [second, third]) {
      const { user } = await (await client("/auth/me")).json();
      assert.equal(
        db
          .prepare("SELECT count(*) AS count FROM settings WHERE user_id = ?")
          .get(user.id).count,
        0,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) AS count FROM chats WHERE user_id = ?")
          .get(user.id).count,
        0,
      );
    }
  } finally {
    db.close();
  }
});

test("expired sessions and cross-site requests cannot access account data", async (t) => {
  const { request, dataDir } = await fixture(t);
  assert.equal(
    (
      await request("/settings", "GET", undefined, {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const login = await request("/auth/login", "POST", {
    username: "测试用户",
    password: "test-password",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const blocked = await fetch(login.url.replace("/auth/login", "/settings"), {
    headers: { Cookie: cookie, Origin: "https://untrusted.example" },
  });
  assert.equal(blocked.status, 403);
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  try {
    db.prepare("UPDATE sessions SET expires_at = 0").run();
  } finally {
    db.close();
  }
  assert.deepEqual(await (await request("/auth/me")).json(), { user: null });
  assert.equal((await request("/chats")).status, 401);
});

test("the Vite proxy preserves the frontend origin for registration, login and authenticated requests", async (t) => {
  const { request } = await fixture(t, undefined, { autoLogin: false });
  const backendOrigin = new URL((await request("/health")).url).origin;
  const { createServer, loadConfigFromFile } = await import("vite");
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.resolve("vite.config.ts"),
  );
  const config = loaded.config;
  const proxy = config.server.proxy["/api"];
  assert.equal(proxy.changeOrigin, false);
  const frontend = await createServer({
    ...config,
    configFile: false,
    logLevel: "silent",
    server: {
      ...config.server,
      port: 0,
      proxy: { "/api": { ...proxy, target: backendOrigin } },
    },
  });
  t.after(() => frontend.close());
  await frontend.listen();
  const port = frontend.httpServer.address().port;
  for (const hostname of ["127.0.0.1", "localhost"]) {
    const origin = `http://${hostname}:${port}`;
    const username =
      hostname === "localhost" ? "localhost-user" : "loopback-user";
    const send = (route, body, cookie = "", source = origin) =>
      fetch(`${origin}/api${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: source,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });
    const registered = await send("/auth/register", {
      username,
      password: "proxy-password",
    });
    assert.equal(registered.status, 201, await registered.text());
    const login = await send("/auth/login", {
      username,
      password: "proxy-password",
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const settings = await fetch(`${origin}/api/settings`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).hasKey, false);
    const foreign = await send(
      "/auth/login",
      { username, password: "proxy-password" },
      cookie,
      "https://untrusted.example",
    );
    assert.equal(foreign.status, 403);
  }
});

test("the server persists streamed responses and reasoning without a final browser save", async (t) => {
  const { request } = await fixture(
    t,
    async () =>
      new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"推理过程","content":"完整答案"}}]}\n\ndata: [DONE]\n\n',
      ),
  );
  await request("/settings", "PUT", {
    baseUrl: "https://stream.test/v1",
    model: "model",
    apiKey: "key",
  });
  await request("/chats/stream", "PUT", {
    id: "stream",
    title: "流式测试",
    mode: "chat",
    updatedAt: new Date().toISOString(),
    messages: [{ id: "question", role: "user", content: "问题" }],
  });
  const output = await (
    await request("/chat", "POST", {
      chatId: "stream",
      assistantId: "answer",
      mode: "chat",
      messages: [{ role: "user", content: "问题" }],
    })
  ).text();
  assert.match(output, /"type":"done"/);
  assert.deepEqual(
    (await (await request("/chats/stream")).json()).messages[1],
    {
      id: "answer",
      role: "assistant",
      content: "完整答案",
      reasoning: "推理过程",
      tools: [],
    },
  );
});

test("closing the browser stream preserves the partial reply on the server", async (t) => {
  let upstreamAborted;
  const stopped = new Promise((resolve) => {
    upstreamAborted = resolve;
  });
  const { request } = await fixture(
    t,
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"已经生成的部分"}}]}\n\n',
              ),
            );
            init.signal.addEventListener(
              "abort",
              () => {
                controller.error(new Error("aborted"));
                upstreamAborted();
              },
              { once: true },
            );
          },
        }),
      ),
  );
  await request("/settings", "PUT", {
    baseUrl: "https://stream.test/v1",
    model: "model",
    apiKey: "key",
  });
  await request("/chats/partial", "PUT", {
    id: "partial",
    title: "中断测试",
    mode: "chat",
    updatedAt: new Date().toISOString(),
    messages: [{ id: "question", role: "user", content: "问题" }],
  });
  const abort = new AbortController();
  const response = await request(
    "/chat",
    "POST",
    {
      chatId: "partial",
      assistantId: "partial-answer",
      messages: [{ role: "user", content: "问题" }],
    },
    { signal: abort.signal },
  );
  const chunk = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(chunk.value), /已经生成的部分/);
  abort.abort();
  await stopped;
  assert.equal(
    (await (await request("/chats/partial")).json()).messages[1].content,
    "已经生成的部分",
  );
});

test("nested folders can be listed, moved and recursively deleted", async (t) => {
  const { request, root } = await fixture(t);
  await fs.mkdir(path.join(root, "算法", "图论", "最短路"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "算法", "图论", "最短路", "Dijkstra.md"),
    "# Dijkstra",
  );
  assert.deepEqual(await (await request("/folders")).json(), [
    "算法",
    "算法/图论",
    "算法/图论/最短路",
  ]);
  assert.equal(
    (await request("/folder", "POST", { path: "算法/图论/最短路" })).status,
    409,
  );
  assert.equal(
    (await request("/folder", "POST", { path: "空目录/子目录" })).status,
    400,
  );
  assert.equal(
    (await request("/folder", "POST", { path: "空目录" })).status,
    200,
  );
  assert.equal(
    (
      await request("/folder/rename", "POST", {
        path: "算法/图论",
        newPath: "算法/图论/最短路/循环",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/folder/rename", "POST", {
        path: "算法/图论",
        newPath: "图论",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/note", "PUT", {
        path: "图论/最短路/Dijkstra.md",
        content: "updated",
      })
    ).status,
    200,
  );
  assert.equal((await request("/folder?path=图论", "DELETE")).status, 200);
  assert.equal((await (await request("/notes")).json()).length, 0);
  assert.deepEqual(await (await request("/folders")).json(), [
    "空目录",
    "算法",
  ]);
  for (const path of ["../outside", "算法/.隐藏", "C:/Windows", "CON"]) {
    assert.equal((await request("/folder", "POST", { path })).status, 400);
  }
});

test("file boundaries reject traversal, system paths, Windows device files and non-Markdown writes", async (t) => {
  const { root, request } = await fixture(t);
  for (const input of [
    "../outside.md",
    "..\\outside.md",
    "C:/secret.md",
    "/absolute.md",
    "folder/../../escape.md",
    "folder/.hidden.md",
    "notes/a.txt",
    "CON.md",
    "a/NUL.md",
    "a /b.md",
  ]) {
    await assert.rejects(notePath(root, input));
    assert.equal(
      (await request("/note", "PUT", { path: input, content: "x" })).status,
      400,
    );
  }
  const blocked = await fetch(
    `http://127.0.0.1:${(await request("/health")).url.split(":")[2].split("/")[0]}/api/notes`,
    { headers: { Origin: "https://untrusted.example" } },
  );
  assert.equal(blocked.status, 403);
});

test("Agent edits exact passages and rejects ambiguous replacement", async (t) => {
  const { root } = await fixture(t);
  await executeTool(root, "write_file", {
    path: "demo.md",
    content: "# 笔记\n原文\n",
  });
  await executeTool(root, "edit_file", {
    path: "demo.md",
    old_text: "原文",
    new_text: "修改后的正文",
  });
  assert.match(
    await executeTool(root, "read_file", { path: "demo.md" }),
    /修改后的正文/,
  );
  await assert.rejects(
    executeTool(root, "edit_file", {
      path: "demo.md",
      old_text: "不存在",
      new_text: "x",
    }),
  );
  await assert.rejects(executeTool(root, "delete_file", { path: "demo.md" }));
});

test("API settings keep keys server-side and normal chat has no injected system messages or file tools", async (t) => {
  let payload;
  const { request } = await fixture(t, async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"你好，同学"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  assert.equal(
    (
      await request("/chat", "POST", {
        messages: [{ role: "user", content: "你好" }],
      })
    ).status,
    400,
  );
  await request("/settings", "PUT", {
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "private-test-key",
  });
  const settings = await (await request("/settings")).json();
  assert.equal(settings.hasKey, true);
  assert.equal(settings.apiKey, "");
  const response = await request("/chat", "POST", {
    mode: "chat",
    thinking: true,
    messages: [{ role: "user", content: "解释二分" }],
  });
  const output = await response.text();
  assert.match(output, /你好，同学/);
  assert.match(output, /"type":"done"/);
  assert.deepEqual(payload.messages, [{ role: "user", content: "解释二分" }]);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.reasoning_effort, "high");
});

test("images persist across restart, stay private, and reach the model as image content", async (t) => {
  let payload;
  const { request, client, restart } = await fixture(t, async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"图片已收到"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const image = {
    name: "题目.png",
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIElEQVR4AdzKQQ0AAACCQGb/zmoCA8jG7wT2uoDZBwgAAAD//w36lLMAAAAGSURBVAMAY8kQATxKvIsAAAAASUVORK5CYII=",
  };
  const chat = {
    id: "image-chat",
    title: "图片题目",
    mode: "chat",
    updatedAt: new Date().toISOString(),
    messages: [{ id: "question", role: "user", content: "", images: [image] }],
  };
  assert.equal((await request("/chats/image-chat", "PUT", chat)).status, 200);
  await restart();
  assert.deepEqual(
    (await (await request("/chats/image-chat")).json()).messages,
    chat.messages,
  );
  const other = client();
  await other("/auth/register", "POST", {
    username: "其他用户",
    password: "test-password",
  });
  assert.equal((await other("/chats/image-chat")).status, 404);
  await request("/settings", "PUT", {
    baseUrl: "https://example.test/v1",
    model: "vision-model",
    apiKey: "test-key",
  });
  const response = await request("/chat", "POST", {
    chatId: chat.id,
    assistantId: "reply",
    messages: chat.messages,
  });
  assert.match(await response.text(), /图片已收到/);
  assert.deepEqual(payload.messages, [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: image.dataUrl } }],
    },
  ]);
  assert.deepEqual(
    (await (await request("/chats/image-chat")).json()).messages[0].images,
    [image],
  );
  const withText = await request("/chat", "POST", {
    messages: [{ role: "user", content: "解释图片", images: [image] }],
  });
  await withText.text();
  assert.deepEqual(payload.messages[0].content[0], {
    type: "text",
    text: "解释图片",
  });
  for (const images of [
    [{ ...image, dataUrl: "https://external.test/image.png" }],
    [{ ...image, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }],
    [{ ...image, dataUrl: "data:image/png;base64,dGV4dA==" }],
    [
      {
        ...image,
        dataUrl:
          "data:image/png;base64," +
          Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      },
    ],
    Array(5).fill(image),
  ]) {
    const message = { ...chat.messages[0], images };
    assert.equal(
      (
        await request("/chats/image-chat", "PUT", {
          ...chat,
          messages: [message],
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/chat", "POST", { messages: [message] })).status,
      400,
    );
  }
});

test("reasoning slider levels reach the upstream API and default omits the parameter", async (t) => {
  let payload;
  const { request } = await fixture(t, async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    );
  });
  await request("/settings", "PUT", {
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "test-key",
  });
  for (const mode of ["chat", "agent"]) {
    for (const reasoningEffort of ["default", "low", "medium", "high"]) {
      const response = await request("/chat", "POST", {
        mode,
        reasoningEffort,
        messages: [{ role: "user", content: "test" }],
      });
      assert.match(await response.text(), /"type":"done"/);
      assert.equal(
        payload.reasoning_effort,
        reasoningEffort === "default" ? undefined : reasoningEffort,
      );
    }
  }
  const invalid = await request("/chat", "POST", {
    reasoningEffort: "invalid",
    messages: [{ role: "user", content: "test" }],
  });
  assert.equal(invalid.status, 400);
});

test("Agent assembles streamed tool arguments, writes a real file, then returns the final answer", async (t) => {
  let round = 0;
  let finalPayload;
  const { request, root } = await fixture(t, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.tools.length);
    assert.ok(!body.messages.some((m) => m.role === "system"));
    if (round++ === 0) {
      const call = {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "测试/文章.md",
                      content: "# Agent 文章\n\n真实文件。",
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
      const bytes = new TextEncoder().encode(
        `data: ${JSON.stringify(call)}\r\n\r\ndata: [DONE]\r\n\r\n`,
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7)
              controller.enqueue(bytes.slice(i, i + 7));
            controller.close();
          },
        }),
      );
    }
    finalPayload = body;
    return new Response(
      'data: {"choices":[{"delta":{"content":"文章已保存。"}}]}\n\ndata: [DONE]',
    );
  });
  await request("/settings", "PUT", {
    baseUrl: "https://example.test/v1",
    model: "agent-model",
    apiKey: "test-key",
  });
  const output = await (
    await request("/chat", "POST", {
      mode: "agent",
      messages: [{ role: "user", content: "创建文章" }],
    })
  ).text();
  assert.match(output, /"type":"tool"/);
  assert.match(output, /文章已保存/);
  assert.match(output, /"type":"done"/);
  assert.equal(
    await fs.readFile(path.join(root, "测试", "文章.md"), "utf8"),
    "# Agent 文章\n\n真实文件。",
  );
  assert.equal(finalPayload.messages.at(-1).role, "tool");
});

test("concurrent conversation saves preserve each independent chat", async (t) => {
  const { request } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      request(`/chats/${i}`, "PUT", {
        id: String(i),
        mode: "chat",
        title: `对话 ${i}`,
        messages: [],
        updatedAt: new Date().toISOString(),
      }),
    ),
  );
  assert.equal((await (await request("/chats")).json()).length, 8);
  await request("/chats/3", "DELETE");
  assert.equal((await (await request("/chats")).json()).length, 7);
});

test("library index reuses unchanged metadata and detects external edits, moves and deletions", async (t) => {
  const { request, root } = await fixture(t);
  await fs.mkdir(path.join(root, "空文件夹"));
  await fs.writeFile(path.join(root, "note.md"), "# 原标题\n\n摘要");
  const cache = new Map();
  const first = await listNotes(root, cache);
  assert.equal((await listNotes(root, cache))[0], first[0]);
  const index = await (await request("/library")).json();
  assert.deepEqual(index.folders, ["空文件夹"]);
  assert.equal(index.notes[0].title, "原标题");
  await fs.writeFile(
    path.join(root, "note.md"),
    "# 外部修改的新标题\n\n新的摘要",
  );
  assert.equal(
    (await (await request("/library")).json()).notes[0].title,
    "外部修改的新标题",
  );
  await fs.rename(
    path.join(root, "note.md"),
    path.join(root, "空文件夹", "moved.md"),
  );
  assert.equal(
    (await (await request("/library")).json()).notes[0].path,
    "空文件夹/moved.md",
  );
  await fs.unlink(path.join(root, "空文件夹", "moved.md"));
  assert.deepEqual((await (await request("/library")).json()).notes, []);
  assert.deepEqual(await listNotes(root, cache), []);
  assert.equal(cache.size, 0);
});

test("simultaneous create-only writes never overwrite the winning note", async (t) => {
  const { request } = await fixture(t);
  const responses = await Promise.all(
    ["first", "second"].map((content) =>
      request("/note", "PUT", { path: "race.md", content, createOnly: true }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const note = await (await request("/note?path=race.md")).json();
  assert.equal(note.content, responses[0].status === 200 ? "first" : "second");
});

test("chat summary omits bodies, reasoning, tools and images and remains account-scoped", async (t) => {
  const { request, client } = await fixture(t);
  const chat = {
    id: "summary",
    mode: "chat",
    title: "标题",
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: "message",
        role: "assistant",
        content: "正文".repeat(10000),
        reasoning: "私有思考",
        tools: [{ name: "read_file", result: "私有工具结果" }],
      },
    ],
  };
  await request("/chats/summary", "PUT", chat);
  const summaries = await (await request("/chats?summary=1")).json();
  assert.deepEqual(Object.keys(summaries[0]).sort(), [
    "id",
    "mode",
    "title",
    "updatedAt",
  ]);
  assert.equal(summaries[0].title, chat.title);
  assert.deepEqual(
    (await (await request("/chats/summary")).json()).messages,
    chat.messages,
  );
  const other = client();
  await other("/auth/register", "POST", {
    username: "其他用户",
    password: "test-password",
  });
  assert.deepEqual(await (await other("/chats?summary=1")).json(), []);
  assert.equal((await other("/chats/summary")).status, 404);
});

test("invalid Agent tool arguments return a tool error and preserve the stream", async (t) => {
  let round = 0;
  const { request } = await fixture(t, async () => {
    const delta =
      round++ === 0
        ? {
            tool_calls: [
              {
                index: 0,
                id: "bad",
                function: { name: "write_file", arguments: "null" },
              },
            ],
          }
        : { content: "参数无效，请重试。" };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await request("/settings", "PUT", {
    baseUrl: "https://example.test/v1",
    model: "test",
    apiKey: "test-key",
  });
  const response = await request(
    "/chat",
    "POST",
    { mode: "agent", messages: [{ role: "user", content: "test" }] },
    { headers: { "Accept-Encoding": "gzip" } },
  );
  assert.equal(response.headers.get("content-encoding"), null);
  const output = await response.text();
  assert.match(output, /文件操作参数必须是对象/);
  assert.match(output, /"type":"done"/);
});
