import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";

test("account profiles, independent drafts, scoped review, persistence and media", async () => {
  const dir = await mkdtemp(tmpdir() + "/draftroom-test-");
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server.mjs"], {
      env: { ...process.env, DATA_DIR: dir, PORT: "3137" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ok, no) => {
      child.stdout.on("data", ok);
      child.on("error", no);
      child.on("exit", (c) => no(Error("server exit " + c)));
    });
  };
  const stop = async () => {
    child.kill();
    await once(child, "exit");
  };
  try {
    await start();
    const db = JSON.parse(await readFile(dir + "/state.json"));
    const call = async (p, method = "GET", data, token = db.edit) =>
      fetch("http://127.0.0.1:3137/api/" + p, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      });
    assert.equal((await call("state", "GET", null, "wrong")).status, 401);
    const first = db.accounts[0],
      other = await (
        await call("accounts", "POST", {
          name: "브랜드 B",
          username: "brand.b",
          displayName: "브랜드 B",
        })
      ).json();
    const drafts = [];
    for (let i = 0; i < 3; i++)
      drafts.push(
        await (
          await call("drafts", "POST", {
            name: "초안 " + i,
            accountId: i < 2 ? first.id : other.id,
          })
        ).json(),
      );
    assert.equal(
      (
        await call("accounts/" + first.id, "PATCH", {
          username: "lets.updated",
          displayName: "공통 프로필",
          verified: true,
        })
      ).status,
      200,
    );
    let state = await (await call("state")).json();
    assert.equal(state.drafts[0].username, "lets.updated");
    assert.equal(state.drafts[1].username, "lets.updated");
    assert.equal(state.drafts[2].username, "brand.b");
    const draft = drafts[0];
    assert.equal(
      (
        await call("drafts/" + draft.id, "PATCH", {
          caption: "한 초안만의 캡션",
        })
      ).status,
      200,
    );
    const scoped = await (
      await call("state", "GET", null, draft.clientKey)
    ).json();
    assert.equal(scoped.client, true);
    assert.equal(scoped.drafts.length, 1);
    assert.equal(scoped.accounts.length, 1);
    assert.equal(scoped.drafts[0].clientKey, undefined);
    assert.equal(scoped.drafts[0].comments, undefined);
    assert.equal(
      (
        await call(
          "drafts/" + draft.id,
          "PATCH",
          { caption: "변경 불가" },
          draft.clientKey,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "accounts/" + first.id,
          "PATCH",
          { name: "변경 불가" },
          draft.clientKey,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "drafts/" + draft.id + "/comments",
          "POST",
          { name: "미지원" },
          draft.clientKey,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("accounts", "POST", { name: "새 계정" }, db.review)).status,
      403,
    );
    const fixture = process.env.VIDEO_FIXTURE;
    if (fixture) {
      assert.equal((await stat(fixture)).size, 104857600);
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const r = await fetch("http://127.0.0.1:3137/api/upload", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + db.edit,
            "Content-Type": "video/mp4",
          },
          body: createReadStream(fixture),
          duplex: "half",
        });
        assert.equal(r.status, 201);
        const m = await r.json();
        ids.push({ ...m, name: "100MB.mp4" });
        assert.equal((await stat(dir + "/media/" + m.id)).size, 104857600);
      }
      assert.equal(
        (await call("drafts/" + draft.id, "PATCH", { media: ids })).status,
        200,
      );
      const range = await fetch(
        "http://127.0.0.1:3137/api/media/" + ids[0].id,
        {
          headers: {
            Authorization: "Bearer " + draft.clientKey,
            Range: "bytes=0-1023",
          },
        },
      );
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 1024);
      assert.equal(
        (await call("media/" + ids[0].id, "GET", null, drafts[2].clientKey))
          .status,
        404,
      );
    }
    const ctrl = new AbortController();
    const events = await fetch(
      "http://127.0.0.1:3137/api/events?key=" + draft.clientKey,
      { signal: ctrl.signal },
    );
    const reader = events.body.getReader();
    await reader.read();
    await call("accounts/" + first.id, "PATCH", { displayName: "실시간 변경" });
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /update/,
    );
    ctrl.abort();
    const before = await (await call("state")).json();
    assert.equal(before.drafts[1].caption, "");
    assert.equal(before.drafts[2].caption, "");
    await stop();
    await start();
    assert.deepEqual(
      (await (await call("state")).json()).drafts,
      before.drafts,
    );
    assert.deepEqual(
      (await (await call("state")).json()).accounts,
      before.accounts,
    );
    assert.equal(
      (await call("drafts/" + draft.id, "PATCH", { fit: "bad" })).status,
      400,
    );
    assert.equal((await (await call("state")).json()).drafts[0].fit, "cover");
  } finally {
    if (child?.exitCode === null) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
