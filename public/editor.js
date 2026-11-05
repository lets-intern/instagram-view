import {cloud, cloudUpload, cloudMedia} from "./cloud.js";
import {
  api,
  state,
  current,
  activeAccount,
  selectedAccount,
  source,
  esc,
  render,
  refresh,
  toast,
  key,
  selectDraft,
  selectAccount,
} from "./viewer.js";
let pending = {},
  profilePending = {},
  timer,
  saving = Promise.resolve(),
  busy = false,
  remotePending = false;
async function flush() {
  clearTimeout(timer);
  const d = current(),
    a = activeAccount();
  const patch = pending,
    pp = profilePending;
  pending = {};
  profilePending = {};
  saving = saving
    .catch(() => {})
    .then(async () => {
      try {
        if (Object.keys(pp).length) await api("accounts/" + a.id, "PATCH", pp);
        if (d && Object.keys(patch).length)
          await api("drafts/" + d.id, "PATCH", patch);
        document
          .querySelector("#save-status")
          ?.replaceChildren(document.createTextNode("✓ 저장됨"));
      } catch (e) {
        pending = { ...patch, ...pending };
        profilePending = { ...pp, ...profilePending };
        toast("저장 실패: " + e.message);
        throw e;
      }
    });
  return saving;
}
window.queueRemote = () => {
  if (
    busy ||
    Object.keys(pending).length ||
    Object.keys(profilePending).length ||
    document.querySelector("#editor")?.contains(document.activeElement)
  ) {
    remotePending = true;
    return;
  }
  refresh().catch((e) => toast(e.message));
};
document.addEventListener("focusout", () =>
  setTimeout(() => {
    if (
      remotePending &&
      !busy &&
      !document.querySelector("#editor")?.contains(document.activeElement)
    ) {
      remotePending = false;
      flush()
        .then(refresh)
        .catch(() => {});
    }
  }, 100),
);
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(() => {}), 500);
  document
    .querySelector("#save-status")
    ?.replaceChildren(document.createTextNode("저장 중…"));
}
function update(field, value) {
  const d = current();
  if (
    field === "type" &&
    value === "reel" &&
    (d.media.length > 1 || d.media.some((m) => !m.type.startsWith("video/")))
  ) {
    toast("릴스로 전환하려면 영상을 1개만 남겨 주세요");
    render();
    return;
  }
  d[field] = value;
  pending[field] = value;
  schedule();
  render(true);
  if (field === "caption") {
    const count = (d.caption.match(/(^|\s)#[^\s#]+/g) || []).length;
    const counter = document.querySelector("#caption-count");
    counter.textContent = d.caption.length.toLocaleString() + " / 2,200";
    counter.classList.toggle("warn", d.caption.length > 2200);
    const tags = document.querySelector("#tag-count");
    tags.textContent = "해시태그 " + count + " / 30";
    tags.classList.toggle("warn", count > 30);
  }
  if (["type", "media", "ratio", "fit", "status"].includes(field))
    window.renderEditor();
}
function updateProfile(field, value) {
  const a = activeAccount();
  a[field] = value;
  profilePending[field] = value;
  if (field !== "name")
    for (const d of state.drafts.filter((d) => d.accountId === a.id))
      d[field] = value;
  schedule();
  render(true);
}
const field = (name, label, value, type = "text", profile = false) =>
  `<label>${label}<input data-${profile ? "profile" : "field"}="${name}" type="${type}" value="${esc(value)}"></label>`;
window.renderEditor = () => {
  const d = current(),
    a = activeAccount();
  document.querySelector("#editor-actions").innerHTML =
    '<span id="save-status">' +
    (Object.keys(pending).length || Object.keys(profilePending).length
      ? "저장 중…"
      : "✓ 저장됨") +
    '</span><button id="share">↗ 팀 검토 링크</button><button id="client-share" class="primary">↗ 거래처 링크</button><button id="export">↓ HTML 파일</button>';
  for (const [id, fn] of [
    ["share", () => share(false)],
    ["client-share", () => share(true)],
    ["export", exportFile],
  ]) {
    document.querySelector("#" + id).disabled = !d;
    document.querySelector("#" + id).onclick = fn;
  }
  document.querySelector("#new-account").innerHTML =
    '<button id="add-account">＋ 계정 추가</button>';
  document.querySelector("#add-account").onclick = async () => {
    const name = prompt("새 계정의 이름을 입력하세요");
    if (!name?.trim()) return;
    try {
      await flush();
      const a = await api("accounts", "POST", {
        name: name.trim(),
        displayName: name.trim(),
      });
      await refresh();
      selectAccount(a.id);
    } catch (e) {
      toast(e.message);
    }
  };
  document.querySelector("#new-draft").innerHTML =
    '<button id="new">＋ 새 초안</button>';
  document.querySelector("#new").onclick = async () => {
    try {
      await flush();
      const created = await api("drafts", "POST", {
        accountId: selectedAccount,
      });
      await refresh();
      selectDraft(created.id);
    } catch (e) {
      toast(e.message);
    }
  };
  for (const el of document.querySelectorAll("[data-draft]"))
    el.onclick = async () => {
      if (busy) return toast("업로드가 끝난 뒤 전환해 주세요");
      try {
        await flush();
        selectDraft(el.dataset.draft);
      } catch {}
    };
  document.querySelector("#account-select").onchange = async (e) => {
    const id = e.target.value;
    if (busy) {
      e.target.value = selectedAccount;
      return toast("업로드가 끝난 뒤 전환해 주세요");
    }
    try {
      await flush();
      selectAccount(id);
    } catch {
      e.target.value = selectedAccount;
    }
  };
  document.querySelector("#editor").innerHTML =
    `<div class="panel-heading"><span class="eyebrow">ACCOUNT PROFILE</span><h2>계정 프로필 <span>공통 설정</span></h2></div><div class="editor-body account-profile"><div class="profile-intro"><div class="avatar">${a.avatar ? `<img data-media-id="${a.avatar.id}" src="${esc(source(a.avatar))}" alt="프로필">` : "L"}</div><p>한 번 설정하면 이 계정의<br>모든 초안에 적용됩니다.</p></div>${field("name", "계정 이름", a.name, "text", true)}<label>프로필 사진<input id="avatar" type="file" accept="image/jpeg,image/png"></label>${field("username", "사용자명", a.username, "text", true)}${field("displayName", "표시 이름", a.displayName, "text", true)}<label class="checkbox"><input data-profile="verified" type="checkbox" ${a.verified ? "checked" : ""}> 인증 배지 표시</label></div>`;
  document
    .querySelectorAll("[data-profile]")
    .forEach((el) =>
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () =>
        updateProfile(
          el.dataset.profile,
          el.type === "checkbox" ? el.checked : el.value,
        ),
      ),
    );
  document.querySelector("#avatar").onchange = (e) =>
    upload([...e.target.files], "avatar");
  if(cloud&&a.avatar)cloudMedia(key,a.avatar).then(url=>{const img=document.querySelector(".profile-intro img");if(img)img.src=url}).catch(e=>toast(e.message));
  if (!d) return;
  const count = (d.caption.match(/(^|\s)#[^\s#]+/g) || []).length;
  document.querySelector("#editor").innerHTML +=
    `<div class="panel-heading"><span class="eyebrow">DRAFT SETTINGS</span><h2>시안 편집 <span>01</span></h2></div><div class="editor-body">${field("name", "초안 이름", d.name)}<div class="two"><label>검토 상태<select data-field="status">${["검토 대기", "승인", "수정 필요"].map((v) => `<option ${v === d.status ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>게시물 유형<select data-field="type"><option value="carousel" ${d.type === "carousel" ? "selected" : ""}>카드뉴스</option><option value="reel" ${d.type === "reel" ? "selected" : ""}>릴스</option></select></label></div><div class="section-label">미디어 <span>${d.media.length} / ${d.type === "reel" ? 1 : 20}</span></div><label class="drop" id="drop"><input id="files" type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime" multiple><span>↥</span><b>파일을 끌어 놓거나 클릭하세요</b><small>JPG, PNG, MP4, MOV · 파일당 100MB</small></label><div id="progress" role="status"></div><div class="media-list">${d.media.map((m, i) => `<div>${m.type.startsWith("image") ? `<img src="${esc(source(m))}" alt="">` : '<span class="video-thumb">▷</span>'}<span>${i + 1}. ${esc(m.name)}</span><button data-up="${i}" aria-label="위로">↑</button><button data-down="${i}" aria-label="아래로">↓</button><button data-delete="${i}" aria-label="삭제">×</button></div>`).join("")}</div>${d.media.length ? '<button id="clear" class="text-button">전체 삭제</button>' : ""}<div class="two"><label>비율<select data-field="ratio">${["1 / 1", "4 / 5", "1.91 / 1"].map((v) => `<option value="${v}" ${v === d.ratio ? "selected" : ""}>${v.replace(" / ", ":")}</option>`).join("")}</select></label><label>미디어 맞춤<select data-field="fit"><option value="cover" ${d.fit === "cover" ? "selected" : ""}>채우기 (cover)</option><option value="contain" ${d.fit === "contain" ? "selected" : ""}>전체 보기 (contain)</option></select></label></div>${d.type === "reel" ? '<label>커버 이미지 (선택)<input id="cover" type="file" accept="image/jpeg,image/png"></label>' + field("audio", "오디오 표기", d.audio) : ""}<div class="section-label">캡션 <span id="caption-count" class="${d.caption.length > 2200 ? "warn" : ""}">${d.caption.length.toLocaleString()} / 2,200</span></div><textarea data-field="caption" rows="5" placeholder="어떤 이야기를 전하고 싶나요?">${esc(d.caption)}</textarea><small id="tag-count" class="${count > 30 ? "warn" : "hint"}">해시태그 ${count} / 30 ${d.caption.length > 2200 || count > 30 ? " · 권장 한도를 초과했습니다" : ""}</small><div class="section-label">연출값</div><div class="two">${field("likes", "좋아요", d.likes, "number")}${field("commentCount", "댓글 수", d.commentCount, "number")}</div>${field("time", "게시 시간", d.time)}${field("location", "위치", d.location)}<button id="delete-draft" class="danger">이 초안 삭제</button></div>`;
  document
    .querySelectorAll("[data-profile]")
    .forEach(
      (el) =>
        (el.oninput = () =>
          updateProfile(
            el.dataset.profile,
            el.type === "checkbox" ? el.checked : el.value,
          )),
    );
  document.querySelector("#avatar").onchange = (e) =>
    upload([...e.target.files], "avatar");
  document
    .querySelectorAll("[data-field]")
    .forEach((el) =>
      el.addEventListener(
        el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input",
        () =>
          update(
            el.dataset.field,
            el.type === "checkbox"
              ? el.checked
              : el.type === "number"
                ? Math.max(0, +el.value)
                : el.value,
          ),
      ),
    );
  document.querySelector("#files").onchange = (e) =>
    upload([...e.target.files]);
  const drop = document.querySelector("#drop");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("dragging");
  };
  drop.ondragleave = () => drop.classList.remove("dragging");
  drop.ondrop = (e) => {
    e.preventDefault();
    upload([...e.dataTransfer.files]);
  };
  document
    .querySelector("#cover")
    ?.addEventListener("change", (e) => upload([...e.target.files], "cover"));
  for (const action of ["up", "down", "delete"])
    document.querySelectorAll("[data-" + action + "]").forEach(
      (b) =>
        (b.onclick = () => {
          const arr = [...d.media],
            i = +b.dataset[action];
          if (action === "delete") arr.splice(i, 1);
          else {
            const j = i + (action === "up" ? -1 : 1);
            if (j < 0 || j >= arr.length) return;
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          update("media", arr);
        }),
    );
  document
    .querySelector("#clear")
    ?.addEventListener("click", () => update("media", []));
  document.querySelector("#delete-draft").onclick = async () => {
    if (!confirm("이 초안을 삭제할까요?")) return;
    try {
      await flush();
      await api("drafts/" + d.id, "DELETE");
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
};
async function share(client = false) {
  try {
    await flush();
    await navigator.clipboard.writeText(
      location.origin +
        location.pathname +
        "?draft=" +
        current().id +
        "#" +
        (client ? current().clientKey : state.reviewKey),
    );
    toast(
      client
        ? "이 초안만 볼 수 있는 거래처 링크를 복사했습니다."
        : "팀 검토 링크를 복사했습니다. 팀 링크에서는 전체 초안을 볼 수 있습니다.",
    );
  } catch {
    toast("클립보드 접근을 허용해 주세요");
  }
}
function send(file, onprogress) {
  if(cloud)return cloudUpload(key,file,onprogress);
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/upload");
    x.setRequestHeader("Authorization", "Bearer " + key);
    x.setRequestHeader(
      "Content-Type",
      file.type ||
        (/\.mov$/i.test(file.name)
          ? "video/quicktime"
          : "application/octet-stream"),
    );
    x.upload.onprogress = (e) =>
      onprogress(
        e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0,
      );
    x.onerror = () => reject(Error("네트워크 연결 실패"));
    x.onload = () => {
      let r;
      try {
        r = JSON.parse(x.responseText);
      } catch {
        return reject(Error("서버 응답 오류"));
      }
      x.status === 201
        ? resolve({ ...r, name: file.name })
        : reject(Error(r.error || "업로드 실패"));
    };
    x.send(file);
  });
}
async function upload(files, purpose) {
  if (busy) return;
  const d = current(),
    a = activeAccount();
  if (!purpose && files.length + d.media.length > (d.type === "reel" ? 1 : 20))
    return toast(
      d.type === "reel"
        ? "릴스는 영상 1개만 추가할 수 있습니다"
        : "최대 20개까지 추가할 수 있습니다",
    );
  busy = true;
  try {
    await flush();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        if (f.size > 100 * 1024 * 1024) throw Error("파일당 최대 100MB입니다");
        if (purpose && !f.type.startsWith("image/"))
          throw Error("이미지를 선택하세요");
        if (!purpose && d.type === "reel" && !f.type.startsWith("video/"))
          throw Error("릴스는 영상을 선택하세요");
        const m = await send(f, (p) => {
          const el = document.querySelector("#progress");
          if (el)
            el.textContent = `${i + 1}/${files.length} · ${f.name} · ${p}%`;
        });
        if (purpose === "avatar") {
          a.avatar = m;
          for (const draft of state.drafts.filter((x) => x.accountId === a.id))
            draft.avatar = m;
          await api("accounts/" + a.id, "PATCH", { avatar: m });
        } else if (purpose) {
          d[purpose] = m;
          await api("drafts/" + d.id, "PATCH", { [purpose]: m });
        } else {
          d.media.push(m);
          await api("drafts/" + d.id, "PATCH", { media: d.media });
        }
      } catch (e) {
        toast(f.name + ": " + e.message);
      }
    }
  } finally {
    busy = false;
    remotePending = false;
    await refresh();
    render();
  }
}
async function exportFile() {
  try {
    await flush();
    const all = confirm(
      "이 계정의 전체 초안을 내보낼까요?\n확인: 계정 전체 초안 / 취소: 현재 초안",
    );
    toast("미디어를 포함한 검토 파일을 만드는 중입니다…");
    const drafts = structuredClone(
      all
        ? state.drafts.filter((d) => d.accountId === selectedAccount)
        : [current()],
    );
    for (const d of drafts) {
      delete d.comments;
      delete d.clientKey;
    }
    const [css, js] = await Promise.all(
      ["./style.css", "./viewer.js"].map((p) =>
        fetch(new URL(p, import.meta.url)).then((r) => r.text()),
      ),
    );
    const payload = JSON.stringify({
      exportId: crypto.randomUUID(),
      accounts: [activeAccount()],
      drafts,
    }).replace(/</g, "\\u003c");
    const viewer = js
      .replace(/^import \{[\s\S]*?\} from ["\']\.\/cloud\.js["\'];?\s*/m, "const cloud=false;\n")
      .replace(/export /g, "")
      .replace("await import('./editor.js');render()", "");
    const parts = [
      '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>시안 검토 · Draftroom</title><style>',
      css,
      '</style><body><div id="app"></div>',
    ];
    const media = new Map();
    for (const d of drafts)
      for (const m of [...d.media, d.cover, d.avatar].filter(Boolean))
        media.set(m.id, m);
    let done = 0;
    for (const m of media.values()) {
      const r = await fetch(cloud?await cloudMedia(key,m):source(m));
      if (!r.ok) throw Error("미디어를 읽을 수 없습니다");
      const blob = await r.blob();
      for (let offset = 0; offset < blob.size; offset += 786432) {
        const bytes = new Uint8Array(
          await blob.slice(offset, offset + 786432).arrayBuffer(),
        );
        let bin = "";
        for (let i = 0; i < bytes.length; i += 8192)
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        parts.push(
          '<script type="application/octet-stream" data-media="' + m.id + '">',
          btoa(bin),
          "<\/script>",
        );
      }
      toast(`검토 파일 준비 중 · ${++done}/${media.size}`);
    }
    parts.push(
      "<script>window.REVIEW_DATA=",
      payload,
      ';<\/script><script type="module">',
      viewer,
      "<\/script></body></html>",
    );
    const url = URL.createObjectURL(
      new Blob(parts, { type: "text/html;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "draftroom-review.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("검토 파일을 내보냈습니다");
  } catch (e) {
    toast("내보내기 실패: " + e.message);
  }
}
