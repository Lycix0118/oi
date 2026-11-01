import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Route } from "@playwright/test";

// Mock the server's persisted reply as well as its stream.
async function saveMockReply(page: Page, route: Route, content: string) {
  const body = route.request().postDataJSON();
  const chat = await (
    await page.request.get(`/api/chats/${body.chatId}`)
  ).json();
  chat.messages.push({ id: body.assistantId, role: "assistant", content });
  expect(
    (await page.request.put(`/api/chats/${body.chatId}`, { data: chat })).ok(),
  ).toBeTruthy();
}

test("multiple model profiles can be created, edited, switched and deleted", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("slider", { name: "思考强度" })).toBeEnabled();
  const createProfile = async (
    name: string,
    model: string,
    endpoint: string,
    key: string,
  ) => {
    if (await page.locator(".model-select").count())
      await page.locator(".model-select").click();
    else
      await page
        .getByRole("button", { name: "管理模型配置", exact: true })
        .click();
    const addProfile = page.getByRole("button", {
      name: "新增配置",
      exact: true,
    });
    if (await addProfile.isEnabled()) await addProfile.click();
    await page
      .getByRole("textbox", { name: "配置名称", exact: true })
      .fill(name);
    await page.getByLabel("接口地址").fill(endpoint);
    await page.getByLabel("添加模型 ID").fill(model);
    await page.getByLabel("API Key", { exact: false }).fill(key);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "模型配置" })).toHaveCount(0);
  };
  await createProfile(
    "快速解题",
    "fast-model",
    "https://fast.invalid/v1",
    "fast-secret",
  );
  await createProfile(
    "深入分析",
    "deep-model",
    "https://deep.invalid/v1",
    "deep-secret",
  );
  const select = page.getByRole("combobox", { name: "快速切换模型" });
  await expect(select.locator("option")).toHaveCount(2);
  await expect(page.locator(".model-select")).toHaveCount(0);
  const settings = await (await page.request.get("/api/settings")).json();
  const fast = settings.profiles.find(
    (p: { name: string }) => p.name === "快速解题",
  );
  await select.selectOption(JSON.stringify([fast.id, "fast-model"]));
  await expect(select.locator("option:checked")).toContainText("fast-model");
  await page.reload();
  await expect(select).toHaveValue(JSON.stringify([fast.id, "fast-model"]));
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: false })).toHaveValue("");
  await page
    .getByRole("button", { name: "移除模型 fast-model", exact: true })
    .click();
  await page.getByLabel("添加模型 ID").fill("fast-model-v2");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(select.locator("option:checked")).toContainText("fast-model-v2");
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除配置", exact: true }).click();
  await expect(select.locator("option")).toHaveCount(1);
  await expect(select.locator("option:checked")).toContainText("deep-model");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/model-profiles-mobile.png",
    fullPage: true,
  });
});

test("one configuration supports manual models, API selection and persistent switching", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".model-select").click();
  await page.getByLabel("配置名称", { exact: true }).fill("共享服务");
  await page.getByLabel("接口地址").fill("https://provider.invalid/v1");
  await page.getByLabel("添加模型 ID").fill("manual-model");
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.getByLabel("API Key", { exact: false }).fill("secret");
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: ["api-fast", "api-deep", "manual-model"],
      }),
    }),
  );
  await page.getByRole("button", { name: "从 API 获取模型列表" }).click();
  await page.getByRole("checkbox", { name: "api-fast", exact: true }).check();
  await page.getByLabel("搜索可用模型").fill("deep");
  await page.getByRole("checkbox", { name: "api-deep", exact: true }).check();
  await page.getByRole("button", { name: "加入所选模型（2）" }).click();
  await expect(
    page.getByRole("region", { name: "配置中的模型" }),
  ).toContainText("api-deep");
  await page.getByLabel("添加模型 ID").fill("extra-model");
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.getByRole("button", { name: "移除模型 extra-model" }).click();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  const select = page.getByRole("combobox", { name: "快速切换模型" });
  await expect(select.locator("optgroup")).toHaveCount(1);
  await expect(select.locator("option")).toHaveCount(3);
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.profiles[0].models).toEqual([
    "manual-model",
    "api-fast",
    "api-deep",
  ]);
  await select.selectOption({ label: "共享服务 · api-deep" });
  await page.reload();
  await expect(select.locator("option:checked")).toHaveText(
    "共享服务 · api-deep",
  );
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: false })).toHaveValue("");
  await page.unroute("**/api/models/discover");
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "获取模型列表失败（HTTP 401）" }),
    }),
  );
  await page.getByRole("button", { name: "从 API 获取模型列表" }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 401");
  await expect(
    page.getByRole("region", { name: "配置中的模型" }),
  ).toContainText("api-fast");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeInViewport();
  const saveBox = await page
    .getByRole("button", { name: "保存配置", exact: true })
    .boundingBox();
  const dialogBox = await page
    .getByRole("dialog", { name: "模型配置" })
    .boundingBox();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(
    dialogBox!.y + dialogBox!.height,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/multi-model-settings-mobile.png",
    fullPage: true,
  });
});

test("model configuration keeps current selection, protects edits and isolates key hints", async ({
  page,
}) => {
  for (const id of ["first", "second"]) {
    expect(
      (
        await page.request.put("/api/settings", {
          data: {
            id,
            name: id,
            baseUrl: `https://${id}.invalid/v1`,
            apiKey: "secret",
            models: ["fast", "deep"],
            model: "fast",
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await page.request.patch("/api/settings", {
    data: { activeModelId: "first", model: "deep" },
  });
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "快速切换模型" });
  const current = JSON.stringify(["first", "deep"]);
  await expect(select).toHaveValue(current);
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "设为默认模型 fast", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /first.*当前使用/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const name = page.getByLabel("配置名称", { exact: true });
  await name.fill("");
  await name.pressSequentially("first-edited");
  await expect(name).toHaveValue("first-edited");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(name).toHaveValue("first-edited");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "second 2 个模型", exact: true })
    .click();
  await expect(name).toHaveValue("first-edited");
  await page.getByLabel("添加模型 ID").fill("pending-model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(select).toHaveValue(current);
  let settings = await (await page.request.get("/api/settings")).json();
  expect(settings.profiles[0].models).toEqual([
    "fast",
    "deep",
    "pending-model",
  ]);
  expect(settings.profiles.map((p: { id: string }) => p.id)).toEqual([
    "first",
    "second",
  ]);
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await page
    .getByRole("button", { name: "second 2 个模型", exact: true })
    .click();
  await page
    .getByRole("radio", { name: "设为默认模型 deep", exact: true })
    .check();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(select).toHaveValue(current);
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  await page.getByRole("button", { name: "新增配置", exact: true }).click();
  const key = page.getByLabel("API Key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveAttribute("placeholder", "输入 API Key");
  await expect(key).toHaveAttribute("required", "");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await expect(select).toHaveValue(current);
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await page
    .getByRole("button", { name: "second 2 个模型", exact: true })
    .click();
  await page.getByRole("button", { name: "使用默认模型", exact: true }).click();
  await expect(select).toHaveValue(JSON.stringify(["second", "deep"]));
  settings = await (await page.request.get("/api/settings")).json();
  expect(settings.activeModelId).toBe("second");
});

test("model discovery preserves manual input, normalizes key reuse and explains empty search results", async ({
  page,
}) => {
  await page.request.put("/api/settings", {
    data: {
      id: "first",
      name: "first",
      baseUrl: "https://first.invalid/v1",
      apiKey: "secret",
      model: "fast",
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await page.getByLabel("接口地址").fill("https://FIRST.invalid:443/v1/");
  const key = page.getByLabel("API Key", { exact: true });
  await expect(key).not.toHaveAttribute("required");
  await page.getByLabel("添加模型 ID").fill("manual-pending");
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({ json: { models: ["fast", "discovered"] } }),
  );
  await page.getByRole("button", { name: "从 API 获取模型列表" }).click();
  await expect(page.getByLabel("添加模型 ID")).toHaveValue("manual-pending");
  await page.getByLabel("搜索可用模型").fill("does-not-exist");
  await expect(page.getByText("没有匹配的模型", { exact: true })).toBeVisible();
  await page.getByLabel("搜索可用模型").fill("");
  await page.getByRole("checkbox", { name: "discovered", exact: true }).check();
  await page.unroute("**/api/models/discover");
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({ status: 400, json: { error: "获取失败" } }),
  );
  await page.getByRole("button", { name: "从 API 获取模型列表" }).click();
  await expect(page.getByRole("alert")).toHaveText("获取失败");
  await expect(
    page.getByRole("checkbox", { name: "discovered", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("添加模型 ID")).toHaveValue("manual-pending");
  await page.getByLabel("接口地址").fill("https://changed.invalid/v1");
  await expect(key).toHaveAttribute("required", "");
  await expect(key).toHaveAttribute("placeholder", "输入 API Key");
  await expect(
    page.getByRole("button", { name: "从 API 获取模型列表" }),
  ).toBeDisabled();
  await expect(page.getByLabel("添加模型 ID")).toHaveValue("manual-pending");
});

test("failed model switches restore selection and settings footer stays visible on short screens", async ({
  page,
}) => {
  const longModel = "long-model-" + "x".repeat(180);
  await page.request.put("/api/settings", {
    data: {
      id: "first",
      name: "first",
      baseUrl: "https://first.invalid/v1",
      apiKey: "secret",
      models: ["fast", longModel],
      model: "fast",
    },
  });
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "快速切换模型" });
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 400, json: { error: "切换失败" } })
      : route.continue(),
  );
  await select.selectOption(JSON.stringify(["first", longModel]));
  await expect(page.getByRole("status")).toContainText("切换失败");
  await expect(select).toHaveValue(JSON.stringify(["first", "fast"]));
  await expect(page.locator(".toast")).toHaveClass(/toast-error/);
  await expect(select).toBeEnabled();
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  for (const viewport of [
    { width: 390, height: 620 },
    { width: 768, height: 480 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("button", { name: "保存配置", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const bounds = await page.locator(".profile-editor-fields").boundingBox();
    expect(bounds!.height).toBeGreaterThan(40);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const dialog = page.getByRole("dialog", { name: "模型配置" });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await page.screenshot({
    path: "test-results/model-settings-small-screen.png",
    fullPage: true,
  });
});

test("read-only server configuration offers valid actions and selected API models save without losing manual input", async ({
  page,
}) => {
  const serverProfile = {
    id: "server-default",
    name: "服务器默认",
    baseUrl: "https://server.invalid/v1",
    model: "server-model",
    models: ["server-model"],
    apiKey: "",
    hasKey: true,
    readOnly: true,
  };
  await page.route("**/api/settings", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            ...serverProfile,
            activeModelId: serverProfile.id,
            profiles: [serverProfile],
          },
        })
      : route.continue(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "管理模型配置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "删除配置", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("API Key", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "显示密钥", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "新增配置", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "placeholder",
    "输入 API Key",
  );
  await page.getByLabel("接口地址").fill("https://personal.invalid/v1");
  await page.getByLabel("API Key", { exact: true }).fill("secret");
  await page.getByLabel("添加模型 ID").fill("manual-pending");
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({ json: { models: ["discovered", "also-selected"] } }),
  );
  await page.getByRole("button", { name: "从 API 获取模型列表" }).click();
  await page.getByRole("checkbox", { name: "discovered", exact: true }).check();
  await page.getByRole("button", { name: "加入所选模型（1）" }).click();
  await expect(page.getByLabel("添加模型 ID")).toHaveValue("manual-pending");
  await page
    .getByRole("checkbox", { name: "also-selected", exact: true })
    .check();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "模型配置" })).toHaveCount(0);
  await page.unroute("**/api/settings");
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.profiles[0].models).toEqual([
    "discovered",
    "also-selected",
    "manual-pending",
  ]);
  expect(settings.profiles[0].model).toBe("discovered");
});

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith("authentication")) return;
  const response = await page.request.post("/api/auth/register", {
    data: {
      username: `ui_${crypto.randomUUID().slice(0, 20)}`,
      password: "ui-test-password",
    },
  });
  expect(response.status()).toBe(201);
});

test("library startup skips Markdown bundles and chat bodies until they are opened", async ({
  page,
}) => {
  const id = crypto.randomUUID();
  const title = `按需加载_${id}`;
  await page.request.put(`/api/chats/${id}`, {
    data: {
      id,
      title,
      mode: "chat",
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "m", role: "assistant", content: "## 按需读取正文\n\n$O(n)$" },
      ],
    },
  });
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(
      new URL(request.url()).pathname + new URL(request.url()).search,
    ),
  );
  await page.goto("/#library");
  await expect(
    page.getByRole("region", { name: "文件资源管理器" }),
  ).toBeVisible();
  expect(requests.filter((url) => url === "/api/library")).toHaveLength(1);
  expect(
    requests.some(
      (url) =>
        url === "/api/folders" ||
        url === "/api/chats" ||
        url.startsWith(`/api/chats/${id}`),
    ),
  ).toBe(false);
  expect(
    requests.some((url) =>
      /\/assets\/(?:MarkdownRenderer|math-|syntax-|markdown-)/.test(url),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "按需读取正文" }),
  ).toBeVisible();
  expect(requests.filter((url) => url === `/api/chats/${id}`)).toHaveLength(1);
  await expect(page.locator(".katex")).toBeVisible();
  await page.getByRole("button", { name: "共享知识库" }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "按需读取正文" }),
  ).toBeVisible();
  // Reopening a chat revalidates its contents to pick up changes from other tabs.
  expect(requests.filter((url) => url === `/api/chats/${id}`)).toHaveLength(2);
});

test("authentication registration, settings persistence, logout and login on mobile", async ({
  page,
}) => {
  const username = `学生_${crypto.randomUUID().slice(0, 12)}`;
  await page.goto("/");
  await expect(
    page
      .locator(".topbar-actions")
      .getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".topbar-actions button")).toHaveCount(2);
  await expect(page.locator(".connection-status")).toHaveCount(0);
  await page
    .locator(".topbar-actions")
    .getByRole("button", { name: "注册", exact: true })
    .click();
  const registration = page.getByRole("dialog", { name: "注册账号" });
  await expect(registration.locator('input[name="username"]')).toBeVisible();
  await expect(registration.locator('input[name="password"]')).toBeVisible();
  await expect(registration.locator("input")).toHaveCount(2);
  await registration.getByRole("textbox", { name: "用户名" }).fill(username);
  await registration
    .locator('input[name="password"]')
    .fill("persistent-password");
  await page.screenshot({ path: "test-results/auth-register-desktop.png" });
  await registration.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.locator(".account-name")).toHaveText(username);
  await expect(page.getByRole("button", { name: "退出登录" })).toBeEnabled();
  await page.locator(".model-select").click();
  const settings = page.getByRole("dialog", { name: "模型配置" });
  await settings
    .getByRole("textbox", { name: /接口地址/ })
    .fill("https://personal.test/v1");
  await settings
    .getByRole("textbox", { name: "添加模型 ID" })
    .fill("personal-model");
  await settings.locator(".password-input input").fill("personal-secret");
  await settings.getByRole("button", { name: "保存配置" }).click();
  await expect(page.locator(".model-quick-select option:checked")).toHaveText(
    "personal-model",
  );
  const effort = page.getByRole("slider", { name: "思考强度" });
  await effort.focus();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings") &&
        response.request().method() === "PATCH" &&
        response.ok(),
    ),
    effort.press("End"),
  ]);
  await page.reload();
  await expect(page.locator(".account-name")).toHaveText(username);
  await expect(effort).toHaveAttribute("aria-valuetext", "高");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(
    page
      .locator(".topbar-actions")
      .getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".model-select")).toHaveText("选择模型");
  expect((await page.request.get("/api/settings")).status()).toBe(401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".topbar-actions")
    .getByRole("button", { name: "登录", exact: true })
    .click();
  const login = page.getByRole("dialog", { name: "登录账号" });
  await login.getByRole("textbox", { name: "用户名" }).fill(username);
  await login.locator('input[name="password"]').fill("wrong-password");
  await login.getByRole("button", { name: "登录", exact: true }).click();
  await expect(login.getByRole("alert")).toHaveText("用户名或密码不正确");
  await login.locator('input[name="password"]').fill("persistent-password");
  await page.screenshot({ path: "test-results/auth-login-mobile.png" });
  await login.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".account-name")).toHaveText(username);
  await expect(page.locator(".model-quick-select option:checked")).toHaveText(
    "personal-model",
  );
  await expect(effort).toHaveAttribute("aria-valuetext", "高");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("authentication two users share notes while keeping conversation and model settings private", async ({
  page,
  browser,
}) => {
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  const baseURL = test.info().project.use.baseURL!;
  const username = `alice_${crypto.randomUUID().slice(0, 12)}`;
  const notePath = `共享测试/${crypto.randomUUID()}.md`;
  try {
    expect(
      (
        await page.request.post("/api/auth/register", {
          data: { username, password: "alice-password" },
        })
      ).status(),
    ).toBe(201);
    await page.request.put("/api/chats/alice-chat", {
      data: {
        id: "alice-chat",
        title: "Alice 私有对话",
        mode: "chat",
        updatedAt: new Date().toISOString(),
        messages: [{ id: "message", role: "user", content: "私有内容" }],
      },
    });
    await page.request.put("/api/settings", {
      data: {
        baseUrl: "https://alice.test/v1",
        model: "alice-model",
        apiKey: "alice-key",
      },
    });
    await page.request.put("/api/note", {
      data: { path: notePath, content: "# 共同笔记\n\nAlice 创建。" },
    });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Alice 私有对话", exact: true }),
    ).toBeVisible();
    await second.goto(baseURL);
    await second
      .locator(".topbar-actions")
      .getByRole("button", { name: "注册", exact: true })
      .click();
    await second
      .getByRole("textbox", { name: "用户名" })
      .fill(`bob_${crypto.randomUUID().slice(0, 12)}`);
    await second.locator('input[name="password"]').fill("bob-password");
    await second.getByRole("button", { name: "注册并登录" }).click();
    await expect(
      second.getByRole("button", { name: "退出登录" }),
    ).toBeEnabled();
    await expect(
      second.getByRole("button", { name: "Alice 私有对话", exact: true }),
    ).toHaveCount(0);
    await expect(second.locator(".model-select")).toHaveText("选择模型");
    expect(
      (await second.request.get(`${baseURL}/api/chats/alice-chat`)).status(),
    ).toBe(404);
    await second
      .locator(".main-nav")
      .getByRole("button", { name: "共享知识库" })
      .click();
    await openNote(second, notePath);
    await expect(
      second.getByText("Alice 创建。", { exact: true }),
    ).toBeVisible();
    await second.getByRole("button", { name: "编辑", exact: true }).click();
    await second
      .getByRole("textbox", { name: "Markdown 编辑器" })
      .fill("# 共同笔记\n\nBob 补充。");
    await second.getByRole("button", { name: "保存修改" }).click();
    await second.getByRole("button", { name: "阅读", exact: true }).click();
    await page.goto("/#library");
    await openNote(page, notePath);
    await expect(page.getByText("Bob 补充。", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/shared-library-desktop.png" });
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(
      page.getByRole("button", { name: "登录后使用" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Alice 私有对话", exact: true }),
    ).toHaveCount(0);
  } finally {
    await second.request.delete(`${baseURL}/api/note`, {
      data: { path: notePath },
    });
    await secondContext.close();
  }
});

async function openNote(page: Page, path: string) {
  if (await page.locator(".reader").isVisible()) {
    await page.getByRole("button", { name: "返回文件夹" }).click();
  }
  await page
    .getByRole("navigation", { name: "当前位置" })
    .getByRole("button", { name: "共享知识库", exact: true })
    .click();
  const parts = path.split("/");
  for (const folder of parts.slice(0, -1)) {
    await page
      .locator(".windows-explorer .explorer-item-name")
      .filter({ hasText: new RegExp(`^${folder}$`) })
      .click();
  }
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/note?path=${encodeURIComponent(path)}`) &&
        response.ok(),
    ),
    page
      .locator(".windows-explorer .explorer-item-name")
      .filter({ hasText: new RegExp(`^${parts.at(-1)!}$`) })
      .click(),
  ]);
  await expect(page.locator(".reader-breadcrumb")).toContainText(path);
  await expect(page.locator(".article-content .markdown")).toBeVisible();
}

test("homepage, real note navigation, search, settings and mobile layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "题目讲解" })).toBeVisible();
  const notes = await (await page.request.get("/api/notes")).json();
  await expect(page.locator(".nav-count")).toHaveText(String(notes.length));
  await page.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: /题意与思路分析|深度思考/ }),
  ).toHaveCount(0);
  await expect(page.getByText("最近笔记", { exact: true })).toHaveCount(0);
  const effort = page.getByRole("slider", { name: "思考强度" });
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveAttribute("aria-valuetext", "默认");
  await effort.focus();
  await effort.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "低");
  await effort.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "中");
  await effort.press("ArrowRight");
  await expect(effort).toHaveAttribute("aria-valuetext", "高");
  await page.screenshot({
    path: "test-results/effort-slider-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "恢复默认思考强度" }).click();
  await expect(effort).toHaveAttribute("aria-valuetext", "默认");
  await page.getByRole("button", { name: "共享知识库" }).click();
  await expect(
    page.getByRole("complementary", { name: "知识库目录" }),
  ).toHaveCount(0);
  await openNote(page, "基础算法/二分查找.md");
  await expect(
    page.getByRole("heading", { name: "二分查找：从有序性到单调性" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/library-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 编辑器" }),
  ).toHaveValue(/lower_bound_index/);
  await expect(page.locator(".split-preview")).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 编辑器" }),
  ).toHaveValue(/lower_bound_index/);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.locator(".sidebar-search").click();
  await page.getByPlaceholder("输入标题或知识点…").fill("背包");
  await page.getByRole("button", { name: /01 背包问题入门/ }).click();
  await expect(
    page.getByRole("heading", { name: "01 背包问题入门" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "知识创作", exact: false })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "知识创作" })).toBeVisible();
  await page.screenshot({
    path: "test-results/agent-desktop.png",
    fullPage: true,
  });
  await page.locator(".model-select").click();
  await expect(page.getByRole("dialog", { name: "模型配置" })).toBeVisible();
  await page.screenshot({
    path: "test-results/settings-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#chat");
  await expect(page.getByRole("heading", { name: "题目讲解" })).toBeVisible();
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "共享知识库" }).click();
  await expect(
    page.getByRole("complementary", { name: "知识库目录" }),
  ).toHaveCount(0);
  await openNote(page, "基础算法/二分查找.md");
  await expect(
    page.getByRole("heading", { name: "二分查找：从有序性到单调性" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/library-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("create, edit, save, rename, download and delete a Markdown file", async ({
  page,
}) => {
  await page.goto("/#library");
  await page.locator(".command-new").click();
  const file = `测试笔记/浏览器验证-${Date.now()}.md`;
  await page.getByRole("textbox", { name: "文件路径" }).fill(file);
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Markdown 编辑器" })
    .fill(
      "# 浏览器验证\n\n这是一篇已经保存的测试笔记。\n\n```cpp\nint main() {}\n```",
    );
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "浏览器验证", exact: true }),
  ).toBeVisible();
  await page.reload();
  await openNote(page, file);
  await expect(
    page.getByText("这是一篇已经保存的测试笔记。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "文件更多操作" }).click();
  await page.getByRole("button", { name: "重命名 / 移动" }).click();
  await page
    .getByRole("textbox", { name: "文件路径" })
    .fill(file.replace("浏览器验证", "已改名"));
  await page.getByRole("button", { name: "保存路径" }).click();
  await page.getByRole("button", { name: "文件更多操作" }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出 Markdown", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain("已改名");
  await page.getByRole("button", { name: "文件更多操作" }).click();
  await page.getByRole("button", { name: "删除笔记", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: file.replace("浏览器验证", "已改名").split("/")[1],
      exact: true,
    }),
  ).toHaveCount(0);
});

test("streamed chat, stop control and conversation persistence with a mocked AI transport", async ({
  page,
}) => {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        baseUrl: "https://test.example/v1",
        model: "test-model",
        apiKey: "",
        hasKey: true,
      },
    }),
  );
  await page.route("**/api/chat", async (route) => {
    const request = route.request().postDataJSON();
    expect(request.reasoningEffort).toBe("medium");
    expect(
      request.messages.every((m: { role: string }) => m.role !== "system"),
    ).toBe(true);
    await saveMockReply(
      page,
      route,
      "## 二分查找\n\n利用单调性，每次排除一半区间。",
    );
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"delta","text":"## 二分查找\\n\\n利用单调性，每次排除一半区间。"}\n\ndata: {"type":"done"}\n\n',
    });
  });
  await page.goto("/");
  const effort = page.getByRole("slider", { name: "思考强度" });
  await expect(effort).toBeEnabled();
  await effort.focus();
  await effort.press("ArrowRight");
  await effort.press("ArrowRight");
  const question = `测试二分思路 ${Date.now()}`;
  await page.getByRole("textbox", { name: "发送题目或问题" }).fill(question);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "二分查找", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "复制回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成" })).toBeVisible();
  await page.screenshot({
    path: "test-results/chat-desktop.png",
    fullPage: true,
  });
  await page.unroute("**/api/chat");
  let finishResponse!: () => void;
  let requestStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    requestStarted();
    await gate;
    await route
      .fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"done"}\n\n',
      })
      .catch(() => {});
  });
  await page
    .getByRole("textbox", { name: "发送题目或问题" })
    .fill("第二个问题：请继续分析");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await started;
  await expect(effort).toBeDisabled();
  await page.getByRole("button", { name: "停止生成" }).click();
  finishResponse();
  await expect(
    page.getByRole("textbox", { name: "发送题目或问题" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: question, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "二分查找", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `删除对话 ${question}` })
    .click({ force: true });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(
    page.getByRole("button", { name: question, exact: true }),
  ).toHaveCount(0);
});

test("paste images into the composer, remove previews, send without text and restore after reload", async ({
  page,
}) => {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        baseUrl: "https://test.example/v1",
        model: "vision-model",
        apiKey: "",
        hasKey: true,
      },
    }),
  );
  let sent:
    | { messages: { content: string; images?: { dataUrl: string }[] }[] }
    | undefined;
  await page.route("**/api/chat", async (route) => {
    sent = route.request().postDataJSON();
    await saveMockReply(page, route, "收到题目图片");
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"delta","text":"收到题目图片"}\n\ndata: {"type":"done"}\n\n',
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "发送题目或问题" });
  await expect(page.getByRole("slider", { name: "思考强度" })).toBeEnabled();
  await input.fill("保留文字");
  const pasteImage = () =>
    input.evaluate((element) => {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIElEQVR4AdzKQQ0AAACCQGb/zmoCA8jG7wT2uoDZBwgAAAD//w36lLMAAAAGSURBVAMAY8kQATxKvIsAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([bytes], "题目.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await pasteImage();
  await expect(input).toHaveValue("保留文字");
  await expect(page.locator(".attachment-image")).toBeVisible();
  await page.getByRole("button", { name: "移除附件 题目.png" }).click();
  await expect(page.locator(".attachment-image")).toHaveCount(0);
  await input.fill("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIElEQVR4AdzKQQ0AAACCQGb/zmoCA8jG7wT2uoDZBwgAAAD//w36lLMAAAAGSURBVAMAY8kQATxKvIsAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([bytes], { type: "image/png" }),
      }),
    ]);
  });
  await input.press("Control+V");
  await expect(page.locator(".attachment-image")).toBeVisible();
  await page.screenshot({ path: "test-results/chat-image-paste.png" });
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("收到题目图片", { exact: true })).toBeVisible();
  expect(sent!.messages[0].content).toBe("");
  expect(sent!.messages[0].images![0].dataUrl).toMatch(
    /^data:image\/png;base64,/,
  );
  await expect(page.locator(".attachment-image")).toHaveCount(0);
  await expect(page.locator(".message-images img")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/chats")).json())[0]?.messages
          .length,
    )
    .toBe(2);
  await page.reload();
  await page.getByRole("button", { name: "image.png", exact: true }).click();
  await expect(page.locator(".message-images img")).toBeVisible();
  expect(
    await page
      .locator(".message-images img")
      .evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBe(8);
});

test("unsaved Markdown stays intact when cancelling navigation and can be discarded explicitly", async ({
  page,
}) => {
  await page.goto("/#library");
  await openNote(page, "基础算法/二分查找.md");
  await expect(
    page.getByRole("heading", { name: "二分查找：从有序性到单调性" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("# 还没有保存的修改");
  await page.getByRole("button", { name: "题目讲解", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "未保存的修改" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(editor).toHaveValue("# 还没有保存的修改");
  await page.getByRole("button", { name: "返回文件夹" }).click();
  await expect(
    page.getByRole("dialog", { name: "未保存的修改" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await openNote(page, "基础算法/前缀和与差分.md");
  await expect(
    page.getByRole("heading", { name: "前缀和与差分", exact: true }),
  ).toBeVisible();
  await openNote(page, "基础算法/二分查找.md");
  await expect(
    page.getByRole("heading", { name: "二分查找：从有序性到单调性" }),
  ).toBeVisible();
});

test("every Markdown note supports fullscreen reading, Escape and mobile controls", async ({
  page,
}) => {
  await page.goto("/#library");
  await expect(page).toHaveTitle("OI");
  await expect(page.locator(".brand")).toHaveText("OI");
  const notes = await (await page.request.get("/api/notes")).json();
  for (const note of notes) {
    await openNote(page, note.path);
    await expect(page.locator(".reader-breadcrumb")).toContainText(note.path);
    await expect(page.locator(".article-content .markdown")).toBeVisible();
    await page.getByRole("button", { name: "全屏查看", exact: true }).click();
    const reader = page.locator(".reader.is-fullscreen");
    await expect(reader).toBeVisible();
    const box = await reader.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".reader.is-fullscreen")).toHaveCount(0);
  }
  await openNote(page, "基础算法/二分查找.md");
  const code = page.locator(".article-content .code-block pre code").first();
  await expect(code).toContainText("lower_bound_index");
  await expect(code).toHaveCSS("font-size", "15px");
  await expect(code).toHaveCSS("font-weight", "500");
  await page.getByRole("button", { name: "全屏查看", exact: true }).click();
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 编辑器" }),
  ).toHaveValue(/lower_bound_index/);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.screenshot({
    path: "test-results/markdown-fullscreen-desktop.png",
  });
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "全屏查看", exact: true }).click();
  await expect(page.locator(".reader.is-fullscreen")).toBeVisible();
  expect(await page.locator(".reader.is-fullscreen").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  const exit = page.getByRole("button", { name: "退出全屏", exact: true });
  await expect(exit).toBeInViewport();
  await page.screenshot({
    path: "test-results/markdown-fullscreen-mobile.png",
  });
  await exit.click();
  await expect(page.locator(".reader.is-fullscreen")).toHaveCount(0);
});

test("LaTeX renders in notes, split preview and chat while ordinary code stays literal", async ({
  page,
}) => {
  const path = `公式测试-${Date.now()}.md`;
  const content = [
    "# 数学公式",
    "",
    "行内复杂度为 $O(\\log n)$，内联代码保持原样：`$x$`。",
    "",
    "$$",
    String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
    "$$",
    "",
    "| 说明 | 公式 |",
    "| --- | --- |",
    String.raw`| 转移 | $f_i = f_{i-1} + f_{i-2}$ |`,
    "",
    "```math",
    String.raw`A = \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`,
    "```",
    "",
    "```python",
    'formula = "$x$"',
    "```",
  ].join("\n");
  expect(
    (
      await page.request.put("/api/note", {
        data: { path, content, createOnly: true },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#library");
  await openNote(page, path);
  const article = page.locator(".article-content");
  await expect(article.locator(".katex")).toHaveCount(4);
  await expect(article.locator(".katex-display")).toHaveCount(2);
  await expect(article.locator(".code-block")).toHaveCount(1);
  await expect(article.locator(".code-block code")).toContainText(
    'formula = "$x$"',
  );
  await expect(article.locator("p > code")).toHaveText("$x$");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "test-results/latex-desktop.png" });
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await expect(page.locator(".split-preview .katex")).toHaveCount(4);
  await page
    .getByRole("textbox", { name: "Markdown 编辑器" })
    .fill(content + "\n\n$\\frac{$");
  await expect(page.locator(".split-preview .katex-error")).toBeVisible();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill(content);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(article.locator(".katex-display")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/latex-mobile.png" });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        baseUrl: "https://test.example/v1",
        model: "math-model",
        apiKey: "",
        hasKey: true,
      },
    }),
  );
  await page.route("**/api/chat", async (route) => {
    await saveMockReply(page, route, content);
    return route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "delta", text: content })}\n\ndata: {"type":"done"}\n\n`,
    });
  });
  await page.goto("/#chat");
  await page.reload();
  await expect(page.getByRole("slider", { name: "思考强度" })).toBeEnabled();
  await page
    .getByRole("textbox", { name: "发送题目或问题" })
    .fill("解释求和公式");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-assistant .katex")).toHaveCount(4);
  await expect(page.locator(".message-assistant .code-block")).toHaveCount(1);
});

test("nested folders support browsing, creating, renaming and recursive deletion", async ({
  page,
}) => {
  const root = `界面验证-${Date.now()}`;
  await page.goto("/#library");
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByRole("textbox", { name: "文件夹路径" }).fill(root);
  await page.getByRole("button", { name: "创建文件夹", exact: true }).click();
  await page
    .locator(".windows-explorer")
    .getByRole("button", { name: root, exact: true })
    .click();
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page
    .getByRole("textbox", { name: "文件夹路径" })
    .fill(`${root}/第二层`);
  await page.getByRole("button", { name: "创建文件夹", exact: true }).click();
  await page
    .locator(".windows-explorer")
    .getByRole("button", { name: "第二层", exact: true })
    .click();
  await page.locator(".command-new").click();
  await page
    .getByRole("textbox", { name: "文件路径" })
    .fill(`${root}/第二层/第三层/嵌套笔记.md`);
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "嵌套笔记", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回文件夹" }).click();
  await expect(page.locator(".address-bar")).toContainText("第三层");
  await page.getByRole("button", { name: "向上", exact: true }).click();
  await expect(page.locator(".address-bar")).toContainText("第二层");
  await page.getByRole("button", { name: "文件夹更多操作 第三层" }).click();
  await page
    .getByRole("button", { name: "重命名 / 移动", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "文件夹路径" })
    .fill(`${root}/第二层/已移动`);
  await page.getByRole("button", { name: "保存路径", exact: true }).click();
  await expect(
    page
      .locator(".windows-explorer")
      .getByRole("button", { name: "已移动", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "详细信息视图" }).click();
  await expect(page.getByRole("table", { name: "文件列表" })).toBeVisible();
  await page.screenshot({ path: "test-results/library-nested-folders.png" });
  await page
    .getByRole("navigation", { name: "当前位置" })
    .getByRole("button", { name: "共享知识库", exact: true })
    .click();
  await page
    .getByRole("button", { name: `文件夹更多操作 ${root}`, exact: true })
    .click();
  await page.getByRole("button", { name: "删除文件夹", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "删除文件夹" })).toContainText(
    "所有子文件夹和笔记",
  );
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page
      .locator(".windows-explorer")
      .getByRole("button", { name: root, exact: true }),
  ).toHaveCount(0);
});
