import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  createReadStream,
  createWriteStream,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
const root = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(root, { recursive: true });
mkdirSync(root + "/media", { recursive: true });
const dbfile = root + "/state.json";
let db = existsSync(dbfile)
  ? JSON.parse(readFileSync(dbfile))
  : {
      drafts: [],
      media: {},
      edit: randomBytes(32).toString("hex"),
      review: randomBytes(32).toString("hex"),
    };
function save() {
  writeFileSync(dbfile + ".tmp", JSON.stringify(db));
  renameSync(dbfile + ".tmp", dbfile);
}
save();
if (!db.accounts) {
  db.accounts = [];
  for (const d of db.drafts) {
    let a = db.accounts.find((a) => a.username === d.username);
    if (!a) {
      a = {
        id: randomUUID(),
        name: d.displayName || d.username,
        username: d.username,
        displayName: d.displayName,
        verified: !!d.verified,
        avatar: d.avatar,
      };
      db.accounts.push(a);
    }
    d.accountId = a.id;
  }
  if (!db.accounts.length)
    db.accounts.push({
      id: randomUUID(),
      name: "렛츠커리어",
      username: "lets.career",
      displayName: "렛츠커리어",
      verified: false,
    });
}
for (const d of db.drafts)
  if (!d.clientKey) d.clientKey = randomBytes(32).toString("hex");
save();
const clients = new Set();
function notify() {
  for (const c of clients) c.write("data: update\n\n");
}
const eq = (a, b) =>
  typeof a === "string" &&
  /^[a-f0-9]{64}$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let chunks = [],
    n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 1024 * 1024) throw Error("요청이 너무 큽니다");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks));
}
function validate(d) {
  if (
    !["carousel", "reel"].includes(d.type) ||
    !["1 / 1", "4 / 5", "1.91 / 1"].includes(d.ratio) ||
    !["cover", "contain"].includes(d.fit) ||
    !["검토 대기", "승인", "수정 필요"].includes(d.status)
  )
    throw Error("설정 값이 올바르지 않습니다");
  for (const k of [
    "name",
    "caption",
    "username",
    "displayName",
    "time",
    "location",
    "audio",
  ])
    if (typeof d[k] !== "string" || d[k].length > 20000)
      throw Error("텍스트 값이 올바르지 않습니다");
  for (const k of ["likes", "commentCount"])
    if (!Number.isFinite(d[k]) || d[k] < 0)
      throw Error("숫자 값이 올바르지 않습니다");
  if (!Array.isArray(d.media) || d.media.length > (d.type === "reel" ? 1 : 20))
    throw Error("카드뉴스 최대 20개, 릴스 영상 1개까지 가능합니다");
  for (const m of [...d.media, d.cover, d.avatar].filter(Boolean))
    if (
      !db.media[m.id] ||
      m.type !== db.media[m.id].type ||
      typeof m.name !== "string"
    )
      throw Error("미디어 값이 올바르지 않습니다");
  if (d.type === "reel" && d.media.some((m) => !m.type.startsWith("video/")))
    throw Error("릴스는 영상만 가능합니다");
  if (
    [d.cover, d.avatar]
      .filter(Boolean)
      .some((m) => !m.type.startsWith("image/"))
  )
    throw Error("커버와 프로필은 이미지만 가능합니다");
}
function profile(a) {
  for (const k of ["name", "username", "displayName"])
    if (typeof a[k] !== "string" || !a[k].trim() || a[k].length > 100)
      throw Error("계정 이름과 사용자명은 1~100자로 입력하세요");
  if (typeof a.verified !== "boolean") throw Error("인증 배지 값 오류");
  if (
    a.avatar &&
    (!db.media[a.avatar.id] || !db.media[a.avatar.id].type.startsWith("image/"))
  )
    throw Error("프로필 이미지를 확인하세요");
}
function present(d, editor = false) {
  const { clientKey, comments, ...safe } = d;
  const a = db.accounts.find((a) => a.id === d.accountId);
  return {
    ...safe,
    username: a.username,
    displayName: a.displayName,
    verified: a.verified,
    avatar: a.avatar,
    ...(editor ? { clientKey } : {}),
  };
}
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const u = new URL(req.url, "http://local");
    if (u.pathname === "/healthz" && req.method === "GET") {
      return json(res, 200, { status: "ok" });
    }
    const token =
      req.headers.authorization?.replace(/^Bearer /, "") ||
      u.searchParams.get("key");
    const editor = eq(token, db.edit),
      team = eq(token, db.review),
      client = db.drafts.find((d) => eq(token, d.clientKey)),
      allowed = editor || team || !!client;
    if (u.pathname.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (!allowed)
        return json(res, 401, { error: "유효한 공유 링크가 필요합니다" });
      if (u.pathname === "/api/state" && req.method === "GET")
        return json(res, 200, {
          drafts: (client ? [client] : db.drafts).map((d) =>
            present(d, editor),
          ),
          accounts: db.accounts.filter(
            (a) => !client || a.id === client.accountId,
          ),
          editor,
          client: !!client,
          reviewKey: editor ? db.review : undefined,
        });
      if (u.pathname === "/api/accounts" && req.method === "POST" && editor) {
        const input = await body(req);
        const a = {
          name: "새 계정",
          username: "new.account",
          displayName: "새 계정",
          verified: false,
          ...input,
          id: randomUUID(),
        };
        profile(a);
        db.accounts.push(a);
        save();
        notify();
        return json(res, 201, a);
      }
      const am = u.pathname.match(/^\/api\/accounts\/([\w-]+)$/);
      if (am && req.method === "PATCH" && editor) {
        const a = db.accounts.find((a) => a.id === am[1]);
        if (!a) return json(res, 404, { error: "계정 없음" });
        const input = await body(req),
          next = { ...a };
        for (const k of [
          "name",
          "username",
          "displayName",
          "verified",
          "avatar",
        ])
          if (k in input) next[k] = input[k];
        profile(next);
        Object.assign(a, next);
        save();
        notify();
        return json(res, 200, a);
      }
      if (u.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        const timer = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(timer);
          clients.delete(res);
        });
        return;
      }
      if (u.pathname === "/api/drafts" && req.method === "POST" && editor) {
        const input = await body(req);
        const d = {
          id: randomUUID(),
          name: "새로운 초안",
          type: "carousel",
          caption: "",
          username: "lets.career",
          displayName: "렛츠커리어",
          verified: false,
          likes: 128,
          commentCount: 8,
          time: "방금 전",
          location: "",
          ratio: "4 / 5",
          fit: "cover",
          status: "검토 대기",
          audio: "오리지널 오디오",
          media: [],
          accountId: db.accounts[0].id,
          ...input,
        };
        d.id = randomUUID();
        d.clientKey = randomBytes(32).toString("hex");
        d.media = [];
        if (!db.accounts.some((a) => a.id === d.accountId))
          throw Error("계정을 선택하세요");
        validate(d);
        db.drafts.push(d);
        save();
        notify();
        return json(res, 201, present(d, true));
      }
      const match = u.pathname.match(/^\/api\/drafts\/([\w-]+)$/);
      if (match) {
        const d = db.drafts.find((x) => x.id === match[1]);
        if (!d || (client && client.id !== d.id))
          return json(res, 404, { error: "초안을 찾을 수 없습니다" });
        if (editor && req.method === "PATCH") {
          const input = await body(req);
          const keys = [
            "name",
            "type",
            "caption",
            "likes",
            "commentCount",
            "time",
            "location",
            "ratio",
            "fit",
            "status",
            "audio",
            "media",
            "cover",
          ];
          const next = { ...d };
          for (const k of keys) if (k in input) next[k] = input[k];
          validate(next);
          Object.assign(d, next);
          save();
          notify();
          return json(res, 200, present(d, true));
        }
        if (editor && req.method === "DELETE") {
          db.drafts = db.drafts.filter((x) => x !== d);
          save();
          notify();
          return json(res, 200, { ok: true });
        }
      }
      if (u.pathname === "/api/upload" && req.method === "POST" && editor) {
        const type = req.headers["content-type"];
        if (
          !["image/jpeg", "image/png", "video/mp4", "video/quicktime"].includes(
            type,
          )
        )
          return json(res, 415, { error: "JPG, PNG, MP4, MOV만 지원합니다" });
        const id = randomUUID();
        const dest = root + "/media/" + id;
        let size = 0;
        const limiter = new Transform({
          transform(c, e, cb) {
            size += c.length;
            cb(
              size > 100 * 1024 * 1024
                ? Error("파일당 최대 100MB입니다")
                : null,
              c,
            );
          },
        });
        try {
          await pipeline(req, limiter, createWriteStream(dest));
        } catch (e) {
          if (existsSync(dest)) unlinkSync(dest);
          throw e;
        }
        db.media[id] = { type, size };
        save();
        return json(res, 201, { id, type, size });
      }
      const media = u.pathname.match(/^\/api\/media\/([\w-]+)$/);
      if (media && req.method === "GET") {
        const m = db.media[media[1]];
        const scoped =
          !client ||
          [
            ...client.media,
            client.cover,
            db.accounts.find((a) => a.id === client.accountId)?.avatar,
          ]
            .filter(Boolean)
            .some((x) => x.id === media[1]);
        if (!m || !scoped) return json(res, 404, { error: "미디어 없음" });
        const file = root + "/media/" + media[1];
        const range = req.headers.range;
        let start = 0,
          end = m.size - 1,
          status = 200;
        if (range) {
          const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parts) {
            res.writeHead(416);
            return res.end();
          }
          if (parts[1]) {
            start = Number(parts[1]);
            end = parts[2] ? Math.min(Number(parts[2]), end) : end;
          } else start = Math.max(0, m.size - Number(parts[2]));
          if (start > end || start >= m.size) {
            res.writeHead(416, { "Content-Range": `bytes */${m.size}` });
            return res.end();
          }
          status = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${m.size}`);
        }
        res.writeHead(status, {
          "Content-Type": m.type,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
        });
        return createReadStream(file, { start, end }).pipe(res);
      }
      return json(res, editor ? 404 : 403, {
        error: "허용되지 않은 요청입니다",
      });
    }
    const files = {
      "/": "index.html",
      "/style.css": "style.css",
      "/viewer.js": "viewer.js",
      "/editor.js": "editor.js",
      "/cloud.js": "cloud.js",
      "/media-worker.js": "media-worker.js",
      "/media-range.js": "media-range.js",
      "/config.js": "config.js",
    };
    const file = files[u.pathname];
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    );
    createReadStream("public/" + file).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end();
  }
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log(`Draftroom ready on port ${server.address().port}`);
  console.log(`Editor: /#${db.edit}\nReviewer: /#${db.review}`);
});
