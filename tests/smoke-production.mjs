import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createApp } from "../server/index.mjs";

process.argv.push("--production");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oi-production-test-"));
await fs.cp(
  new URL("./fixtures/notes/", import.meta.url),
  path.join(dataDir, "notes"),
  { recursive: true },
);
const app = await createApp({ dataDir });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const html = await page.request.get(page.url());
  assert.equal(html.headers()["cache-control"], "no-cache");
  const htmlBody = await html.text();
  assert.doesNotMatch(
    htmlBody,
    /modulepreload[^>]+(?:math-|syntax-|markdown-)/,
  );
  const assetPath = htmlBody.match(/src="([^"]+\.js)"/)[1];
  const asset = await page.request.get(new URL(assetPath, page.url()).href, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.match(asset.headers()["cache-control"], /immutable/);
  assert.equal(asset.headers()["content-encoding"], "gzip");
  await page.getByRole("heading", { name: "题目讲解" }).waitFor();
  await page
    .locator(".topbar-actions")
    .getByRole("button", { name: "注册", exact: true })
    .click();
  await page.getByRole("textbox", { name: "用户名" }).fill("production-user");
  await page.locator('input[name="password"]').fill("production-password");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await page.getByRole("button", { name: "退出登录" }).waitFor();
  const notes = await (
    await page.request.get(new URL("/api/notes", page.url()).href)
  ).json();
  await page
    .locator(".nav-count")
    .filter({ hasText: String(notes.length) })
    .waitFor();
  await page.screenshot({ path: "test-results/production-home.png" });
  await page.getByRole("button", { name: "共享知识库" }).click();
  await page
    .locator(".windows-explorer .explorer-item-name")
    .filter({ hasText: /^基础算法$/ })
    .click();
  await page
    .locator(".windows-explorer .explorer-item-name")
    .filter({ hasText: /^二分查找.md$/ })
    .click();
  await page
    .getByRole("heading", { name: "二分查找：从有序性到单调性" })
    .waitFor();
  assert.equal(await page.locator(".code-block code").count(), 1);
  await page.reload();
  await page
    .locator(".account-name")
    .filter({ hasText: "production-user" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "生产构建检查通过：注册、登录持久化、共享知识库、Markdown 和代码高亮均可正常使用。",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  app.locals.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
