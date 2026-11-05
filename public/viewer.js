import {cloud, cloudApi, cloudMedia, cloudVideo} from "./cloud.js";
const embedded = window.REVIEW_DATA;
export const offline = !!embedded;
export const key = location.hash.slice(1);
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function api(url, method = "GET", data) {
  if(cloud) return cloudApi(key,url,method,data||{});
  const r = await fetch("/api/" + url, {
    method,
    headers: {
      Authorization: "Bearer " + key,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error);
  return b;
}
export let state = { drafts: [], accounts: [], editor: false };
export let selectedAccount =
  new URL(location.href).searchParams.get("account") || "";
export const activeAccount = () =>
  state.accounts.find((a) => a.id === selectedAccount);
export function selectAccount(id) {
  selectedAccount = id;
  selected = state.drafts.find((d) => d.accountId === id)?.id || "";
  slide = 0;
  if (!offline) {
    const url = new URL(location.href);
    url.searchParams.set("account", id);
    url.searchParams.delete("draft");
    history.replaceState(null, "", url);
  }
  render();
}
export let selected = new URL(location.href).searchParams.get("draft") || "";
let slide = 0,
  mode = "feed",
  expanded = false,
  dark = false;
const urls = new Map();
export function selectDraft(id) {
  selected = id;
  selectedAccount =
    state.drafts.find((d) => d.id === id)?.accountId || selectedAccount;
  slide = 0;
  expanded = false;
  if (!offline) {
    const url = new URL(location.href);
    url.searchParams.set("draft", id);
    url.searchParams.set("account", selectedAccount);
    history.replaceState(null, "", url);
  }
  render();
}
export const current = () => state.drafts.find((d) => d.id === selected);
export const source = (m) => {
  if (!m) return "";
  if (!offline && cloud) return urls.get(m.id)||"";
  if (!offline) return "/api/media/" + m.id + "?key=" + encodeURIComponent(key);
  if (m.data) return m.data;
  if (urls.has(m.id)) return urls.get(m.id);
  const chunks = [
    ...document.querySelectorAll('script[data-media="' + m.id + '"]'),
  ];
  const parts = chunks.map((el) => {
    const bin = atob(el.textContent.trim());
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    el.remove();
    return arr;
  });
  const url = URL.createObjectURL(new Blob(parts, { type: m.type }));
  urls.set(m.id, url);
  return url;
};
export function toast(message) {
  document.querySelector("#notice").textContent = message;
  setTimeout(() => {
    document.querySelector("#notice").textContent = "";
  }, 6000);
}
function caption(d) {
  return esc(d.caption).replace(
    /(^|\s)([#@][^\s#@]+)/g,
    '$1<span class="tag">$2</span>',
  );
}
function mediaHTML(m, d) {
  if (!m)
    return '<div class="empty-art"><span>＋</span><strong>당신의 다음 이야기를<br>미리 만나보세요</strong><small>이미지와 영상을 추가하면 여기에 표시됩니다</small></div>';
  return m.type.startsWith("video")
    ? `<video data-media-id="${m.id}" ${source(m)?`src="${esc(source(m))}"`:""} autoplay muted loop playsinline preload="metadata" style="object-fit:${d.fit}" ${d.cover ? `poster="${esc(source(d.cover))}"` : ""}></video><span class="loading">영상 로딩 중…</span><button class="sound" title="음소거 전환">♫</button>`
    : `<img data-media-id="${m.id}" ${source(m)?`src="${esc(source(m))}"`:""} style="object-fit:${d.fit}" alt="슬라이드 ${slide + 1}">`;
}
function account(d) {
  return `<div class="account"><div class="avatar">${d.avatar ? `<img data-media-id="${d.avatar.id}" ${source(d.avatar)?`src="${esc(source(d.avatar))}"`:""} alt="프로필">` : "L"}</div><div><b>${esc(d.username)} ${d.verified ? '<span class="badge">✓</span>' : ""}</b><small>${esc(d.location || d.displayName)}</small></div><span class="dots-menu">•••</span></div>`;
}
function post(d) {
  const reel = mode === "reels";
  const m = d.media[Math.min(slide, d.media.length - 1)];
  return `${!reel ? account(d) : ""}<div class="media ${reel ? "reel" : ""}" style="aspect-ratio:${reel ? "9 / 16" : d.type === "reel" ? "4 / 5" : d.ratio}">${mediaHTML(m, d)}${d.media.length > 1 ? `<span class="counter">${slide + 1}/${d.media.length}</span><button class="prev" aria-label="이전 슬라이드">‹</button><button class="next" aria-label="다음 슬라이드">›</button>` : ""}${reel ? `<div class="reel-icons">♡<br>♧<br>➤<br>⋯</div><div class="reel-overlay">${account(d)}<div class="caption ${expanded ? "expanded" : ""}">${caption(d)}</div><button class="more">더 보기</button><small>♫ ${esc(d.audio)}</small></div>` : ""}</div>${!reel ? `<div class="actions"><span>♡　♧　➤</span><span>♧</span></div><div class="indicators">${d.media.map((_, i) => `<button data-slide="${i}" class="${i === slide ? "active" : ""}" aria-label="${i + 1}번 슬라이드"></button>`).join("")}</div><div class="post-copy"><b>좋아요 ${Number(d.likes || 0).toLocaleString()}개</b><div class="caption ${expanded ? "expanded" : ""}"><b>${esc(d.username)}</b> ${caption(d)}</div>${d.caption ? '<button class="more">더 보기</button>' : ""}<small>댓글 ${esc(d.commentCount)}개 모두 보기</small><small>${esc(d.time)}</small></div>` : ""}`;
}
let videoObserver;
export function render(previewOnly = false) {
  const d = current(),
    a = activeAccount();
  const drafts = state.drafts.filter((d) => d.accountId === selectedAccount);
  const phone = d
    ? `<div class="preview-tools"><div class="segments">${[
        ["feed", "홈 피드"],
        ["detail", "게시물 상세"],
        ["reels", "릴스 탭"],
      ]
        .map(
          ([v, t]) =>
            `<button data-mode="${v}" class="${v === mode ? "selected" : ""}">${t}</button>`,
        )
        .join(
          "",
        )}</div><span class="size-label">390 × 844</span></div><div class="phone ${dark ? "dark" : ""}"><div class="statusbar"><b>9:41</b><span>▰ ◔ ▰</span></div><div class="phone-scroll">${mode === "feed" ? '<div class="phone-title">홈 <span>♡　♧</span></div><div class="stories">' + ["내 스토리", d.username, "design.daily", "creative.log"].map((n, i) => `<div><div class="story s${i}">${["＋", "L", "D", "C"][i]}</div><small>${esc(n)}</small></div>`).join("") + '</div><div class="dummy"><b>creative.notes</b><span>새로운 영감을 발견하는 순간 ✨</span></div>' : mode === "detail" ? '<div class="phone-title">‹ <b>게시물</b> ⋯</div>' : '<div class="phone-title">릴스 <span>⌕</span></div>'}${post(d)}${mode === "feed" ? '<div class="dummy after"><b>daily.inspiration</b><span>오늘도, 당신만의 속도로.</span></div>' : ""}</div><div class="phone-nav">⌂　⌕　⊞　▷　◉</div></div><p class="disclaimer">내부 검토용 미리보기 · 실제 서비스가 아닙니다</p>`
    : `<div class="welcome"><div class="empty-symbol">▧</div><h2>이 계정의 첫 시안을 만들어 보세요</h2><p>프로필을 한 번 설정하고, 게시물 초안을 계속 추가하세요.</p></div>`;
  if (previewOnly && document.querySelector(".preview")) {
    document.querySelector(".preview").innerHTML = phone;
    bindPreview();
    return;
  }
  document.querySelector("#app").innerHTML =
    `<header><a class="brand" href="${esc(location.pathname + location.search + "#" + key)}"><span>▧</span> draftroom<span class="brand-dot">.</span></a><span class="brand-sub">LET’S CAREER · CREATIVE REVIEW</span><div class="header-right"><span class="live-dot"></span>${offline ? "오프라인 미리보기" : state.client ? "거래처 검토" : "팀 워크스페이스"}<button id="theme" aria-label="다크 모드">◐</button></div></header><div class="workspace-head"><div><span class="eyebrow">MAKE IT LOOK RIGHT</span><h1>게시 전, 한 번 더.</h1><p>계정별로 시안을 모으고, 실제 화면에서 확인하세요.</p></div><div id="editor-actions"></div></div><div id="notice" role="status"></div><div class="account-toolbar"><label>계정<select id="account-select">${state.accounts.map((a) => `<option value="${a.id}" ${a.id === selectedAccount ? "selected" : ""}>${esc(a.name)} · @${esc(a.username)}</option>`).join("")}</select></label><span class="account-meta">${drafts.length}개의 초안</span><div id="new-account"></div></div><div class="draft-bar"><div class="draft-tabs">${drafts.map((x) => `<button data-draft="${x.id}" class="${x.id === selected ? "selected" : ""}"><span class="draft-dot"></span>${esc(x.name)}</button>`).join("")}</div><div id="new-draft"></div></div><main class="${state.editor ? "" : "review-only"}"><aside id="editor" class="panel"></aside><section class="preview">${d ? `<div class="draft-summary"><span class="pill">${esc(d.status)}</span><span>${esc(d.name)}</span></div>` : ""}${phone}</section></main><footer>draftroom · 계정마다 쌓아가는 다음 이야기 <span>BY LET’S CAREER</span></footer>`;
  document
    .querySelectorAll("[data-draft]")
    .forEach((b) => (b.onclick = () => selectDraft(b.dataset.draft)));
  document.querySelector("#account-select").onchange = (e) =>
    selectAccount(e.target.value);
  document.querySelector("#theme").onclick = () => {
    dark = !dark;
    render();
  };
  bindPreview();
  if (state.editor) window.renderEditor?.();
}
const streamingFailed=new Set();
async function loadCloudMedia(){
 const d=current();if(!d)return;
 const targets=[...document.querySelectorAll('[data-media-id]')];
 await Promise.all(targets.map(async el=>{
  const m=[...d.media,d.cover,d.avatar].filter(Boolean).find(m=>m.id===el.dataset.mediaId);if(!m)return;
  try{
   const url=el.tagName==='VIDEO'&&!streamingFailed.has(m.id)?await cloudVideo(key,m):await cloudMedia(key,m);
   urls.set(m.id,url);if(!el.isConnected)return;
   if(el.src!==url)el.src=url;
   if(el.tagName==='VIDEO'){
    if(d.cover)cloudMedia(key,d.cover).then(poster=>{if(el.isConnected)el.poster=poster}).catch(()=>{});
    el.play().catch(()=>{});
   }
  }catch(e){if(el.isConnected){const hint=el.parentElement?.querySelector('.loading');if(hint)hint.textContent=e.message;else el.alt='미디어 로딩 실패'}}
 }));
}

function bindPreview() {
  const d = current();
  if (!d) return;
  if(cloud&&!offline)loadCloudMedia();
  document.querySelectorAll("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.mode;
        render();
      }),
  );
  const go = (n) => {
    slide = (n + d.media.length) % d.media.length;
    render();
  };
  const prev = document.querySelector(".prev"),
    next = document.querySelector(".next");
  if (prev) prev.onclick = () => go(slide - 1);
  if (next) next.onclick = () => go(slide + 1);
  document
    .querySelectorAll("[data-slide]")
    .forEach((b) => (b.onclick = () => go(+b.dataset.slide)));
  let sx;
  const media = document.querySelector(".media");
  media.ontouchstart = (e) => (sx = e.changedTouches[0].clientX);
  media.ontouchend = (e) => {
    const delta = e.changedTouches[0].clientX - sx;
    if (Math.abs(delta) > 40 && d.media.length > 1)
      go(slide + (delta < 0 ? 1 : -1));
  };
  const more = document.querySelector(".more");
  if (more)
    more.onclick = () => {
      expanded = !expanded;
      render();
    };
  videoObserver?.disconnect();
  const video = document.querySelector("video");
  if (video) {
    videoObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) video.pause();
          else video.play().catch(() => {});
        }
      },
      { root: document.querySelector(".phone-scroll"), threshold: 0.15 },
    );
    videoObserver.observe(video);
    video.onclick = () => (video.paused ? video.play() : video.pause());
    video.oncanplay = () =>
      video.parentElement?.querySelector(".loading")?.remove();
    video.onerror = async () => {
      const m=d.media[Math.min(slide,d.media.length-1)];
      if(cloud&&!offline&&m&&video.src.includes('/__media/')&&!streamingFailed.has(m.id)){
        streamingFailed.add(m.id);
        try{const url=await cloudMedia(key,m);urls.set(m.id,url);if(video.isConnected){video.src=url;video.play().catch(()=>{})}return}catch{}
      }
      const hint = video.parentElement?.querySelector(".loading");
      if (hint)
        hint.textContent = "브라우저가 이 영상 코덱을 지원하지 않습니다";
    };
    document.querySelector(".sound").onclick = () => {
      video.muted = !video.muted;
    };
    if(video.getAttribute("src"))video.play().catch(() => {
      const hint = video.parentElement?.querySelector(".loading");
      if (hint) hint.textContent = "영상을 눌러 재생하세요";
    });
  }
}
let lastRemoteState="",refreshVersion=0;
export async function refresh() {
  const version=++refreshVersion;
  const next = offline
    ? { drafts: embedded.drafts, accounts: embedded.accounts, editor: false }
    : await api("state");
  if(version!==refreshVersion)return;
  const snapshot=JSON.stringify(next);if(snapshot===lastRemoteState)return;lastRemoteState=snapshot;state=next;
  if (!state.accounts.some((a) => a.id === selectedAccount))
    selectedAccount =
      state.drafts.find((d) => d.id === selected)?.accountId ||
      state.accounts[0]?.id ||
      "";
  if (
    !state.drafts.some(
      (d) => d.id === selected && d.accountId === selectedAccount,
    )
  )
    selected =
      state.drafts.find((d) => d.accountId === selectedAccount)?.id || "";
  render();
}
async function init() {
  try {
    await refresh();
    if (state.editor) {
      await import("./editor.js");
      render();
    }
    if (!offline && cloud) {
      setInterval(()=>window.queueRemote?window.queueRemote():refresh().catch(e=>toast(e.message)),5000);
    }
    if (!offline && !cloud) {
      const events = new EventSource(
        "/api/events?key=" + encodeURIComponent(key),
      );
      events.onmessage = () =>
        window.queueRemote
          ? window.queueRemote()
          : refresh().catch((e) => toast(e.message));
      events.onerror = () => toast("연결을 복구하는 중입니다…");
    }
  } catch (e) {
    document.querySelector("#app").innerHTML =
      `<div class="welcome"><h1>검토 링크를 확인해 주세요</h1><p>${esc(e.message)}</p><p>편집자에게 받은 전체 링크로 접속하세요.</p></div>`;
  }
}
init();
