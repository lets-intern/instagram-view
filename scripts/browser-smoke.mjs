import { chromium } from "playwright";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import assert from "node:assert/strict";

const fixture = process.env.VIDEO_FIXTURE || "/tmp/draftroom-100mb.mp4";
await fs.access(fixture);
const dir = await fs.mkdtemp("/tmp/draftroom-browser-");
const image = dir + "/image.png";
await fs.writeFile(
  image,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
let browser, artifactServer, page;
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, DATA_DIR: dir, PORT: "3140" },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((ok, no) => {
    server.stdout.once("data", ok);
    server.once("error", no);
    server.once("exit", (c) => no(Error("server exit " + c)));
  });
  const db = JSON.parse(await fs.readFile(dir + "/state.json"));
  const base = "http://127.0.0.1:3140";
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/#" + db.edit);
  await page.locator('[data-profile="username"]').fill("career.team");
  await page.locator('[data-profile="displayName"]').fill("공통 프로필");
  await page.locator('[data-profile="verified"]').check();
  await page.locator("#avatar").setInputFiles(image);
  await page.waitForFunction(() =>
    document.querySelector(".profile-intro img"),
  );
  await page.getByRole("button", { name: "＋ 새 초안" }).click();
  await page.locator('[data-field="name"]').fill("혼합 캐러셀");
  await page
    .locator('[data-field="caption"]')
    .fill("첫 문장\n두 번째 문장 #커리어\n세 번째 문장 @career.team");
  await page.waitForTimeout(800);
  await page
    .locator("#files")
    .setInputFiles([fixture, fixture, fixture, image, image]);
  await page.waitForFunction(
    () => document.querySelectorAll(".media-list>div").length === 5,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  assert.equal(await page.locator(".account b").innerText(), "career.team ✓");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "다음 슬라이드" }).click();
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    await page.waitForTimeout(300);
    assert.ok(await page.locator("video").evaluate((v) => v.currentTime > 0));
  }
  await page.getByRole("button", { name: "다음 슬라이드" }).click();
  assert.equal(await page.locator(".media>img").count(), 1);
  await page.reload();
  await page.locator("#files").waitFor();
  assert.equal(await page.locator(".media-list>div").count(), 5);
  assert.equal(
    await page.locator('[data-profile="username"]').inputValue(),
    "career.team",
  );
  await page.getByRole("button", { name: "＋ 새 초안" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".media-list>div").length === 0,
  );
  assert.equal(await page.locator('[data-field="caption"]').inputValue(), "");
  assert.equal(
    await page.locator('[data-profile="username"]').inputValue(),
    "career.team",
  );
  await page.locator('[data-field="name"]').fill("릴스 시안");
  await page.locator('[data-field="type"]').selectOption("reel");
  await page.locator("#files").setInputFiles(fixture);
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  await page.getByRole("button", { name: "릴스 탭", exact: true }).click();
  assert.equal(
    await page
      .locator(".media")
      .evaluate((el) => Math.round((el.clientHeight / el.clientWidth) * 100)),
    178,
  );
  await page.locator('[data-profile="username"]').fill("career.updated");
  await page.waitForTimeout(800);
  const state = await (
    await context.request.get(base + "/api/state", {
      headers: { Authorization: "Bearer " + db.edit },
    })
  ).json();
  assert.equal(state.drafts[0].username, "career.updated");
  assert.equal(state.drafts[1].username, "career.updated");
  const review = await context.newPage();
  review.on("pageerror", (e) => errors.push(e.message));
  const reel = state.drafts[1];
  await review.goto(base + "/?draft=" + reel.id + "#" + reel.clientKey);
  assert.equal(await review.locator("[data-draft]").count(), 1);
  assert.equal(await review.locator("[data-profile]").count(), 0);
  assert.equal(await review.locator("#feedback").count(), 0);
  await review.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  await page.locator('[data-profile="displayName"]').fill("거래처에도 반영");
  await page.waitForTimeout(800);
  await review.getByText("거래처에도 반영", { exact: true }).waitFor();
  page.once("dialog", (d) => d.accept("두 번째 계정"));
  await page.getByRole("button", { name: "＋ 계정 추가" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#account-select")
      ?.selectedOptions[0].textContent.includes("두 번째 계정"),
  );
  assert.equal(await page.locator("[data-draft]").count(), 0);
  await page.getByRole("button", { name: "＋ 새 초안" }).click();
  await page.locator('[data-field="name"]').fill("다른 계정 초안");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".media-list>div").count(), 0);
  await page.locator("#account-select").selectOption(db.accounts[0].id);
  await page.getByRole("button", { name: "릴스 시안", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  page.once("dialog", (d) => d.dismiss());
  const downloading = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: "↓ HTML 파일" }).click();
  const download = await downloading;
  await download.saveAs("/tmp/draftroom-review.html");
  assert.ok((await fs.stat("/tmp/draftroom-review.html")).size > 139000000);
  artifactServer = http
    .createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      createReadStream("/tmp/draftroom-review.html").pipe(res);
    })
    .listen(3138, "127.0.0.1");
  await once(artifactServer, "listening");
  const offline = await browser.newContext();
  const file = await offline.newPage();
  file.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  file.on("request", (r) => requests.push(r.url()));
  await file.goto("http://127.0.0.1:3138");
  await offline.setOffline(true);
  await file.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  assert.equal(await file.locator("#feedback").count(), 0);
  assert.equal(await file.locator("[data-profile]").count(), 0);
  assert.equal(
    requests.filter(
      (u) => u.startsWith("http") && !u.startsWith("http://127.0.0.1:3138"),
    ).length,
    0,
  );
  await page.screenshot({ path: "/tmp/draftroom-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/draftroom-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: shared account profiles/avatar, 3×100MiB + 2-image carousel/reload, independent accounts/drafts, reels, scoped client link/live updates, no feedback UI, 100MiB offline HTML playback, responsive layout",
  );
} catch (e) {
  if (page) {
    await page
      .screenshot({ path: "/tmp/draftroom-failure.png", fullPage: true })
      .catch(() => {});
    console.error(
      await page
        .evaluate(() => ({
          notice: document.querySelector("#notice")?.textContent,
          type: document.querySelector("[data-field=type]")?.value,
          media: document.querySelector(".media-list")?.textContent,
          video: document.querySelector("video")
            ? {
                ready: document.querySelector("video").readyState,
                error: document.querySelector("video").error?.message,
              }
            : null,
        }))
        .catch(() => ({})),
    );
  }
  throw e;
} finally {
  await browser?.close();
  artifactServer?.close();
  server.kill();
  await once(server, "exit").catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
