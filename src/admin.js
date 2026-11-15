// 管理页面与账号接口。
//
//   GET  /admin                  单页应用（文件、token、用户）
//   POST /admin/api/login        { username, password } → 会话 cookie
//   POST /admin/api/logout
//   GET  /admin/api/me
//   GET/POST/DELETE /admin/api/users...
//   GET/POST/DELETE /admin/api/tokens...
//
// 文件操作复用 /api/*（cookie 或 token 都认），这里不重复实现。

import {
  SESSION_COOKIE,
  clearCookie,
  hashPassword,
  newToken,
  readCookie,
  readSession,
  sessionCookie,
  sessionPayload,
  signSession,
  tokenKey,
  verifyPassword,
} from "./auth.js";
import {
  deleteToken,
  deleteUser,
  getToken,
  getUser,
  listTokens,
  listUsers,
  publicUser,
  putToken,
  putUser,
} from "./users.js";
import { sameOrigin } from "./access.js";
import { deleteAssets } from "./github.js";
import {
  assetIdsOf,
  deleteDirRecord,
  deleteFileRecord,
  listUser,
} from "./store.js";
import { esc, html, json, readJson, text } from "./http.js";

const USER_NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const TOKEN_KEY_RE = /^token:[0-9a-f]{64}$/;
// 口令上限：PBKDF2 对超长口令只多一次预哈希，但没必要接受。
const MAX_PASSWORD = 256;

export async function handleAdmin(request, env, cfg, path) {
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32 || !env.USERS) {
    return text("服务未配置：SESSION_SECRET 缺失或短于 32 字符，或缺少 USERS 绑定", 500);
  }

  const claims = await readSession(cfg.sessionSecret, readCookie(request, SESSION_COOKIE));

  // 会话里的角色可能已经过时（被降级、停用、删除），每次都以 KV 为准。
  let session = null;
  if (claims) {
    const user = await getUser(env, claims.u);
    if (user && !user.disabled && (claims.v || 0) === (user.ver || 0)) {
      session = { u: user.name, r: user.role };
    }
  }

  if (path === "/admin" || path === "/admin/") {
    return html(renderAdmin(cfg, session), 200, {
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
  }

  if (!path.startsWith("/admin/api/")) return json({ error: "没有这个接口" }, 404);

  const route = path.slice("/admin/api/".length);

  // 包括登录在内的所有写操作都要求同源，防止跨站把受害者登进攻击者的账号。
  if (!sameOrigin(request, new URL(request.url))) {
    return json({ error: "跨站请求被拒绝" }, 403);
  }

  if (route === "login") return login(request, env, cfg);
  if (route === "logout") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearCookie(cfg),
        "cache-control": "no-store",
      },
    });
  }

  if (!session) return json({ error: "未登录" }, 401);

  if (route === "me") {
    return json({ user: session.u, role: session.r });
  }

  const isAdmin = session.r === "admin";

  if (route === "users") {
    if (!isAdmin) return json({ error: "需要管理员权限" }, 403);
    if (request.method === "GET") return json({ users: await listUsers(env) });
    if (request.method === "POST") return addUser(request, env, cfg);
    return json({ error: "方法不允许" }, 405);
  }

  let m = /^users\/([^/]+)\/(password|disable|enable)$/.exec(route);
  if (m) {
    let name;
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      return json({ error: "用户名不合法" }, 400);
    }
    // 普通用户只能改自己的口令；停用/启用只有管理员能做。
    if (!isAdmin && (m[2] !== "password" || name !== session.u)) {
      return json({ error: "需要管理员权限" }, 403);
    }
    if (request.method !== "POST") return json({ error: "方法不允许" }, 405);
    return userAction(request, env, cfg, name, m[2], session);
  }

  m = /^users\/([^/]+)$/.exec(route);
  if (m) {
    if (!isAdmin) return json({ error: "需要管理员权限" }, 403);
    if (request.method !== "DELETE") return json({ error: "方法不允许" }, 405);
    let name;
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      return json({ error: "用户名不合法" }, 400);
    }
    return removeUser(env, cfg, name, session);
  }

  if (route === "tokens") {
    if (request.method === "GET") {
      return json({ tokens: await listTokens(env, isAdmin ? null : session.u) });
    }
    if (request.method === "POST") return createToken(request, env, session);
    return json({ error: "方法不允许" }, 405);
  }

  m = /^tokens\/([^/]+)$/.exec(route);
  if (m) {
    if (request.method !== "DELETE") return json({ error: "方法不允许" }, 405);
    let key;
    try {
      key = decodeURIComponent(m[1]);
    } catch {
      key = "";
    }
    // 只接受 token 键，避免借这个接口删掉 KV 里的其它记录。
    if (!TOKEN_KEY_RE.test(key)) return json({ error: "token 标识不合法" }, 400);
    const rec = await getToken(env, key);
    if (!rec) return json({ error: "没有这个 token" }, 404);
    if (!isAdmin && rec.user !== session.u) return json({ error: "只能删除自己的 token" }, 403);
    await deleteToken(env, key);
    return json({ deleted: key });
  }

  return json({ error: "没有这个接口" }, 404);
}

// ── 登录 ──────────────────────────────────────────────────────────────

async function login(request, env, cfg) {
  if (request.method !== "POST") return json({ error: "方法不允许" }, 405);

  const body = await readJson(request);
  if (!body) return json({ error: "请求体必须是 JSON" }, 400);

  // 频率限制在 zone 的速率限制规则里做，这里不写 KV。
  const name = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!USER_NAME_RE.test(name) || password.length < 1 || password.length > MAX_PASSWORD) {
    return json({ error: "用户名或口令不正确" }, 401);
  }

  const user = await getUser(env, name);

  // 用户不存在时也走一次同样的哈希，避免用响应时间区分账号是否存在。
  const record = user ?? {
    salt: "00".repeat(16),
    hash: "x",
    iterations: cfg.passwordIterations,
  };
  const ok = await verifyPassword(password, record);

  if (!user || !ok || user.disabled) {
    return json({ error: "用户名或口令不正确" }, 401);
  }

  const value = await signSession(
    cfg.sessionSecret,
    sessionPayload(user.name, user.role, user.ver),
  );
  return new Response(JSON.stringify({ user: publicUser(user) }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": sessionCookie(cfg, value),
      "cache-control": "no-store",
    },
  });
}

// ── 用户 ──────────────────────────────────────────────────────────────

async function addUser(request, env, cfg) {
  const body = await readJson(request);
  if (!body) return json({ error: "请求体必须是 JSON" }, 400);

  const name = String(body.username || "").trim();
  const password = String(body.password || "");
  const role = body.role === "admin" ? "admin" : "user";

  if (!USER_NAME_RE.test(name)) {
    return json({ error: "用户名只能包含字母、数字、下划线、连字符，长度 2–32" }, 400);
  }
  if (password.length < 8 || password.length > MAX_PASSWORD) {
    return json({ error: `口令长度须在 8–${MAX_PASSWORD} 之间` }, 400);
  }
  if (await getUser(env, name)) return json({ error: "用户名已存在" }, 409);

  const { salt, hash, iterations } = await hashPassword(password, cfg.passwordIterations);
  const record = {
    name,
    salt,
    hash,
    iterations,
    role,
    created: new Date().toISOString(),
    ver: 0,
  };
  await putUser(env, record);
  return json({ user: publicUser(record) }, 201);
}

async function userAction(request, env, cfg, name, action, session) {
  const user = await getUser(env, name);
  if (!user) return json({ error: "没有这个用户" }, 404);

  if (action === "password") {
    const body = await readJson(request);
    if (!body) return json({ error: "请求体必须是 JSON" }, 400);
    const password = String(body.password || "");
    if (password.length < 8 || password.length > MAX_PASSWORD) {
      return json({ error: `口令长度须在 8–${MAX_PASSWORD} 之间` }, 400);
    }

    const { salt, hash, iterations } = await hashPassword(password, cfg.passwordIterations);
    // ver 自增：旧会话和旧 token 一并失效。
    const next = { ...user, salt, hash, iterations, ver: (user.ver || 0) + 1 };
    await putUser(env, next);

    const tokens = await listTokens(env, name);
    for (const t of tokens) await deleteToken(env, t.key);
    return json({ ok: true, tokensRevoked: tokens.length });
  }

  const disabled = action === "disable";
  if (disabled && user.name === session.u) return json({ error: "不能停用自己" }, 400);
  await putUser(env, { ...user, disabled });
  return json({ user: publicUser({ ...user, disabled }) });
}

async function removeUser(env, cfg, name, session) {
  if (name === session.u) return json({ error: "不能删除自己" }, 400);
  if (!(await getUser(env, name))) return json({ error: "没有这个用户" }, 404);

  // 至少留一个可用管理员。
  const admins = (await listUsers(env)).filter((u) => u.role === "admin" && !u.disabled);
  if (admins.length <= 1 && admins.some((u) => u.name === name)) {
    return json({ error: "至少要保留一个管理员" }, 400);
  }

  // 账号名下的文件一并清理：先拿到清单，再删资产，最后删索引和账号。
  // 大文件有好几段，每段都要删；删不掉的成为孤儿，由对账任务收拾。
  const { files, dirs } = await listUser(env, name);
  const failures = [];
  for (const f of files) {
    if ((await deleteAssets(cfg, assetIdsOf(f))).length) failures.push(f.path);
  }

  const tokens = await listTokens(env, name);
  for (const t of tokens) await deleteToken(env, t.key);
  for (const f of files) await deleteFileRecord(env, name, f.path);
  for (const d of dirs) await deleteDirRecord(env, name, d);
  await deleteUser(env, name);

  return json({
    deleted: name,
    tokens: tokens.length,
    files: files.length,
    dirs: dirs.length,
    ...(failures.length ? { assetsNotDeleted: failures } : {}),
  });
}

// ── token ─────────────────────────────────────────────────────────────

async function createToken(request, env, session) {
  const body = await readJson(request);
  if (!body) return json({ error: "请求体必须是 JSON" }, 400);

  const label = String(body.label || "").slice(0, 60);
  const owner = session.r === "admin" && body.user ? String(body.user) : session.u;
  const ownerRec = await getUser(env, owner);
  if (!ownerRec) return json({ error: "没有这个用户" }, 404);

  const token = newToken();
  const key = await tokenKey(token);
  await putToken(env, key, {
    user: owner,
    label,
    created: new Date().toISOString(),
    v: ownerRec.ver || 0,
  });

  // 明文只此一次。
  return json({ token, key, user: owner, label }, 201);
}

// ── 页面 ──────────────────────────────────────────────────────────────

function renderAdmin(cfg, session) {
  const me = session ? JSON.stringify({ user: session.u, role: session.r }) : "null";
  const base = JSON.stringify(cfg.basePath || "");
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(cfg.siteName)} · 管理</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1f2328;--muted:#606a75;--line:#e3e5e8;--card:#fff;--accent:#2f6feb;--danger:#c62828}
 @media(prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa4b0;--line:#2c3138;--card:#1d2025;--accent:#4d8dfa;--danger:#ef5350}}
 *{box-sizing:border-box}
 body{margin:0;padding:32px 20px 72px;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  display:flex;justify-content:center}
 main{width:100%;max-width:820px}
 h1{font-size:22px;margin:0 0 4px}
 h2{font-size:14px;margin:28px 0 10px;color:var(--muted);font-weight:600;text-transform:none}
 .sub{color:var(--muted);font-size:13px;margin:0 0 18px}
 input,button,select{font:inherit;padding:8px 11px;border-radius:7px;
  border:1px solid var(--line);background:var(--card);color:var(--fg)}
 input{width:100%}
 button{cursor:pointer;background:var(--accent);color:#fff;border-color:transparent;font-weight:600}
 button.ghost{background:transparent;color:var(--fg);border-color:var(--line);font-weight:400}
 button.danger{background:transparent;color:var(--danger);border-color:var(--line);font-weight:400}
 button:disabled{opacity:.45;cursor:default}
 .row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
 .row>input{flex:1;min-width:140px}
 nav{display:flex;gap:4px;margin:20px 0 8px;border-bottom:1px solid var(--line)}
 nav button{background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;
  border-radius:0;padding:8px 12px;font-weight:500}
 nav button.on{color:var(--fg);border-bottom-color:var(--accent)}
 table{width:100%;border-collapse:collapse;font-size:14px}
 td,th{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
 th{color:var(--muted);font-weight:500;font-size:12px}
 td.actions{white-space:nowrap;text-align:right}
 td.actions button{padding:4px 8px;font-size:13px}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;
  background:#0000000d;padding:2px 5px;border-radius:4px}
 @media(prefers-color-scheme:dark){code{background:#ffffff14}}
 .msg{margin:12px 0;padding:9px 12px;border-radius:7px;font-size:13px;display:none}
 .msg.on{display:block}
 .ok{background:#2e7d3222;color:#2e7d32}
 .err{background:#c6282822;color:var(--danger)}
 .muted{color:var(--muted);font-size:13px}
 .crumbs{margin:0 0 10px;font-size:14px}
 .crumbs a{color:var(--accent);cursor:pointer;text-decoration:none}
 .crumbs span{color:var(--muted)}
 .drop{border:1px dashed var(--line);border-radius:9px;padding:14px;text-align:center;
  color:var(--muted);font-size:13px;margin-bottom:12px}
 .drop.hot{border-color:var(--accent);color:var(--accent)}
 .name{cursor:pointer;color:var(--accent)}
 .up{font-size:12px;color:var(--muted);margin-top:6px;white-space:pre-wrap}
 progress{width:100%;height:8px;margin-top:6px;accent-color:var(--accent)}
 .hide{display:none}
</style></head><body><main>
<h1>${esc(cfg.siteName)}</h1>
<p class="sub">文件箱管理</p>
<div id="msg" class="msg"></div>
<div id="app"></div>
</main>
<script>
const BASE = ${base};
const ME = ${me};

const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

function say(t, kind) {
  const m = $("#msg");
  m.textContent = t;
  m.className = "msg on " + (kind || "ok");
  clearTimeout(say.t);
  say.t = setTimeout(function () { m.className = "msg"; }, 6000);
}

async function api(path, opts) {
  const res = await fetch(BASE + path, Object.assign({
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
  }, opts || {}));
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
const jpost = (p, body) => api(p, { method: "POST", body: JSON.stringify(body || {}) });

function sizeText(n) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + " " + units[i];
}
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
}); }
function joinPath(dir, name) { return dir ? dir + "/" + name : name; }
function parentOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function baseOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }

// ── 登录 ──
function renderLogin() {
  const u = el("input", { placeholder: "用户名", autocomplete: "username" });
  const p = el("input", { type: "password", placeholder: "口令", autocomplete: "current-password" });
  const go = async function () {
    try {
      await jpost("/admin/api/login", { username: u.value, password: p.value });
      location.reload();
    } catch (e) { say(e.message, "err"); }
  };
  p.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  $("#app").replaceChildren(
    el("div", { class: "row" }, u),
    el("div", { class: "row" }, p),
    el("div", { class: "row" }, el("button", { onclick: go }, "登录"))
  );
}

// ── 外壳与标签页 ──
const TABS = { files: "文件", tokens: "API Token" };
if (ME && ME.role === "admin") TABS.users = "用户";

function shell(active) {
  const app = $("#app");
  const out = el("button", { class: "ghost", onclick: async function () {
    await jpost("/admin/api/logout"); location.reload();
  } }, "退出");
  const pwd = el("button", { class: "ghost", onclick: async function () {
    await changePwd(ME.user);
  } }, "修改口令");
  const tabs = el("nav", {}, Object.keys(TABS).map(function (k) {
    return el("button", { class: k === active ? "on" : "", onclick: function () { go(k); } }, TABS[k]);
  }));
  app.replaceChildren(
    el("div", { class: "row" }, el("span", { class: "muted" }, "已登录：" + ME.user + "（" + ME.role + "）"), pwd, out),
    tabs,
    el("div", { id: "view" })
  );
  return $("#view");
}
function go(tab) { location.hash = tab; }

function route() {
  if (!ME) return renderLogin();
  const tab = (location.hash || "#files").slice(1);
  if (!TABS[tab]) return go("files");
  const view = shell(tab);
  if (tab === "files") renderFiles(view);
  else if (tab === "tokens") renderTokens(view);
  else renderUsers(view);
}
window.addEventListener("hashchange", route);

// ── 文件 ──
let curDir = "";

async function fetchEntries(dir) {
  const data = await api("/api/files");
  const dirs = new Set(data.dirs);
  for (const f of data.files) {
    let d = parentOf(f.path);
    while (d) { dirs.add(d); d = parentOf(d); }
  }
  const childDirs = [];
  dirs.forEach(function (d) { if (parentOf(d) === dir) childDirs.push(d); });
  const childFiles = data.files.filter(function (f) { return parentOf(f.path) === dir; });
  childDirs.sort();
  return { dirs: childDirs, files: childFiles, limits: data.limits };
}

async function renderFiles(view) {
  view.replaceChildren(el("p", { class: "muted" }, "加载中…"));

  let entries;
  try { entries = await fetchEntries(curDir); }
  catch (e) { view.replaceChildren(el("p", { class: "muted" }, e.message)); return; }

  const crumbs = el("div", { class: "crumbs" },
    el("a", { onclick: function () { curDir = ""; renderFiles(view); } }, "根目录"));
  let acc = "";
  for (const seg of curDir ? curDir.split("/") : []) {
    acc = joinPath(acc, seg);
    const target = acc;
    crumbs.append(el("span", {}, " / "),
      el("a", { onclick: function () { curDir = target; renderFiles(view); } }, seg));
  }

  const fileInput = el("input", {
    type: "file", multiple: "", class: "hide",
    onchange: function () { uploadFiles(fileInput.files, view, status); fileInput.value = ""; }
  });

  const status = el("div", { class: "up" });
  const lim = entries.limits;
  const quota = lim ? el("p", { class: "muted" },
    "共 " + lim.files + " 个文件，占用名额 " + lim.assets + "/" + lim.maxAssets + "，长期 " + lim.keep + "/" + lim.maxKeep + " 个。" +
    "大文件分段存储，每 95 MB 左右占一个名额。" +
    "这是临时存储：超过个人上限、或者全站文件太多时，最旧的非长期文件会被自动删除。") : null;
  const drop = el("div", { class: "drop" }, "把文件拖到这里，或点「上传文件」（单文件上限 2 GB）");
  drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("hot"); });
  drop.addEventListener("dragleave", function () { drop.classList.remove("hot"); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault(); drop.classList.remove("hot");
    uploadFiles(e.dataTransfer.files, view, status);
  });

  const rows = [];
  for (const d of entries.dirs) {
    rows.push(el("tr", {},
      el("td", { class: "name", onclick: function () { curDir = d; renderFiles(view); } }, "📁 " + baseOf(d)),
      el("td", { class: "muted" }, "目录"),
      el("td", { class: "muted" }, ""),
      el("td", { class: "actions" },
        el("button", { class: "danger", onclick: function () { removeFolder(d, view); } }, "删除"))));
  }
  for (const f of entries.files) {
    const url = location.origin + f.url;
    rows.push(el("tr", {},
      el("td", {}, f.keep ? el("span", { title: "长期文件，不会被自动删除" }, "📌 ") : null, baseOf(f.path)),
      el("td", { class: "muted" }, sizeText(f.size)),
      el("td", { class: "muted" }, String(f.created).slice(0, 10)),
      el("td", { class: "actions" },
        el("a", { href: url, target: "_blank", rel: "noopener" }, el("button", { class: "ghost" }, "下载")),
        " ",
        el("button", { class: "ghost", onclick: function () { copy(url); } }, "复制链接"),
        " ",
        el("button", { class: "ghost", onclick: function () { toggleKeep(f, view); } }, f.keep ? "取消长期" : "设为长期"),
        " ",
        el("button", { class: "ghost", onclick: function () { moveFile(f, view); } }, "重命名"),
        " ",
        el("button", { class: "danger", onclick: function () { removeFile(f, view); } }, "删除"))));
  }

  view.replaceChildren(
    crumbs,
    quota,
    el("div", { class: "row" },
      el("button", { onclick: function () { fileInput.click(); } }, "上传文件"),
      el("button", { class: "ghost", onclick: function () { newFolder(view); } }, "新建文件夹"),
      el("button", { class: "ghost", onclick: function () { renderFiles(view); } }, "刷新"),
      fileInput),
    drop,
    status,
    el("table", {},
      el("thead", {}, el("tr", {},
        el("th", {}, "名称"), el("th", {}, "大小"), el("th", {}, "创建"), el("th", {}, ""))),
      el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "4", class: "muted" }, "空目录"))))
  );
}

// fetch 拿不到上传进度，所以上传用 XMLHttpRequest。
// 进度到 100% 只说明字节到了 Cloudflare，Worker 还要把它转给 GitHub，
// 这一段要等服务端响应才算完。
function sendFile(url, file, onProgress, extraHeaders) {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.withCredentials = true;
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    for (const k in extraHeaders || {}) x.setRequestHeader(k, extraHeaders[k]);
    x.upload.onprogress = function (e) { onProgress(e.loaded, e.lengthComputable ? e.total : file.size); };
    x.upload.onload = function () { onProgress(file.size, file.size); };
    x.onload = function () {
      let data = {};
      try { data = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300) { resolve(data); return; }
      const err = new Error(data.error || ("HTTP " + x.status));
      err.status = x.status;
      reject(err);
    };
    x.onerror = function () { reject(new Error("网络错误")); };
    x.onabort = function () { reject(new Error("已取消")); };
    x.send(file);
  });
}

// 507：release 满了，服务端已经清理了一批旧文件，重传一次。
async function sendRetry(url, body, onProgress, headers) {
  try {
    return await sendFile(url, body, onProgress, headers);
  } catch (e) {
    if (e.status !== 507 || !/已自动清理/.test(e.message)) throw e;
    say(e.message);
    return sendFile(url, body, onProgress, headers);
  }
}

let limits = null;
async function uploadLimits() {
  if (!limits) limits = await api("/api/upload/limits");
  return limits;
}

// 大文件按服务端给的段长切开，逐段上传换回执，最后交回全部回执。
// 一段失败就整个放弃：已经传上去的段没有索引，过几个小时会被自动清掉。
async function sendParts(path, file, lim, onProgress) {
  const of = Math.ceil(file.size / lim.partBytes);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
  const q = "path=" + encodeURIComponent(path);
  const receipts = [];
  for (let n = 1; n <= of; n++) {
    const from = (n - 1) * lim.partBytes;
    const blob = file.slice(from, Math.min(file.size, from + lim.partBytes), "application/octet-stream");
    const url = location.origin + BASE + "/api/upload/part?" + q + "&id=" + id + "&n=" + n + "&of=" + of + "&size=" + file.size;
    const r = await sendRetry(url, blob, function (loaded) { onProgress(from + loaded, file.size, n, of); });
    receipts.push(r.receipt);
  }
  onProgress(file.size, file.size, of, of);
  const res = await fetch(location.origin + BASE + "/api/upload/complete?" + q + "&overwrite=1", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "text/plain", "x-file-type": file.type || "application/octet-stream" },
    body: receipts.join("\\n"),
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

let uploading = false;
window.addEventListener("beforeunload", function (e) {
  if (uploading) { e.preventDefault(); e.returnValue = ""; }
});

async function uploadFiles(list, view, status) {
  const files = Array.from(list || []);
  if (!files.length) return;
  if (uploading) { say("上一批还在上传，等它传完再试", "err"); return; }
  uploading = true;
  const bar = el("progress", { max: "1", value: "0" });
  const line = el("div", {});
  status.replaceChildren(line, bar);
  let done = 0;
  try {
    const lim = await uploadLimits();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const tag = files.length > 1 ? "（" + (i + 1) + "/" + files.length + "）" : "";
      if (f.size > lim.maxFileBytes) {
        say(f.name + " 超过单文件上限 " + sizeText(lim.maxFileBytes) + "，跳过", "err");
        continue;
      }
      const name = f.name.replace(/[\\/\\u0000-\\u001f\\u007f]/g, "_").trim() || "file";
      const path = joinPath(curDir, name);
      const target = location.origin + BASE + "/api/upload?path=" + encodeURIComponent(path) + "&overwrite=1";
      const start = Date.now();
      const progress = function (loaded, total, n, of) {
          bar.max = total || 1;
          bar.value = loaded;
          const seg = of > 1 ? "第 " + n + "/" + of + " 段，" : "";
          if (total && loaded >= total) {
            line.textContent = "正在上传 " + name + tag + "：已传到服务器，正在写入 GitHub…";
            return;
          }
          const secs = (Date.now() - start) / 1000;
          const rate = secs > 0.5 ? "，" + sizeText(loaded / secs) + "/s" : "";
          const pct = total ? "（" + Math.floor(loaded * 100 / total) + "%）" : "";
          line.textContent = "正在上传 " + name + tag + "：" + seg + sizeText(loaded) + " / " + sizeText(total) + pct + rate;
      };
      try {
        if (f.size > lim.partBytes) await sendParts(path, f, lim, progress);
        else await sendRetry(target, f, progress);
        done += 1;
      } catch (e) {
        say(name + " 上传失败：" + e.message, "err");
        break;
      }
    }
  } catch (e) {
    say("上传失败：" + e.message, "err");
  } finally {
    uploading = false;
    status.replaceChildren();
  }
  if (done) say("已上传 " + done + " 个文件");
  renderFiles(view);
}

async function toggleKeep(f, view) {
  try {
    await api("/api/keep?path=" + encodeURIComponent(f.path), { method: f.keep ? "DELETE" : "POST" });
    say((f.keep ? "已取消长期：" : "已设为长期：") + f.path);
    renderFiles(view);
  } catch (e) { say(e.message, "err"); }
}

async function newFolder(view) {
  const name = prompt("新文件夹名称");
  if (!name) return;
  try {
    await jpost("/api/folder", { path: joinPath(curDir, name.trim()) });
    renderFiles(view);
  } catch (e) { say(e.message, "err"); }
}

// 改的是完整路径：只改文件名就是重命名，改了目录部分就是移动。
// 以 / 结尾、或者填一个已有的目录，就移进那个目录，名字不变。
async function moveFile(f, view) {
  const to = prompt("新路径（改目录部分就是移动；填已有目录或以 / 结尾，就移进那个目录）", f.path);
  if (!to || to.trim() === f.path) return;
  try {
    const r = await api("/api/move?from=" + encodeURIComponent(f.path) + "&to=" + encodeURIComponent(to.trim()), { method: "POST" });
    say("已移动到 " + r.file.path + "，下载地址变了，旧链接不能再用");
    renderFiles(view);
  } catch (e) { say(e.message, "err"); }
}

async function removeFile(f, view) {
  if (!confirm("删除 " + f.path + "？")) return;
  try {
    await api("/api/file?path=" + encodeURIComponent(f.path), { method: "DELETE" });
    say("已删除 " + f.path);
    renderFiles(view);
  } catch (e) { say(e.message, "err"); }
}

async function removeFolder(d, view) {
  if (!confirm("删除目录 " + d + "？（必须为空）")) return;
  try {
    await api("/api/folder?path=" + encodeURIComponent(d), { method: "DELETE" });
    renderFiles(view);
  } catch (e) { say(e.message, "err"); }
}

function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { say("链接已复制"); });
  else { prompt("复制这个链接：", text); }
}

// ── token ──
async function renderTokens(view) {
  const box = el("div", {}, el("p", { class: "muted" }, "加载中…"));
  view.replaceChildren(box);
  try {
    const data = await api("/admin/api/tokens");
    const rows = data.tokens.map(function (t) {
      return el("tr", {},
        el("td", {}, t.user),
        el("td", {}, t.label || "—"),
        el("td", { class: "muted" }, String(t.created).slice(0, 10)),
        el("td", { class: "actions" },
          el("button", { class: "danger", onclick: async function () {
            if (!confirm("吊销这个 token？")) return;
            try { await api("/admin/api/tokens/" + encodeURIComponent(t.key), { method: "DELETE" }); renderTokens(view); }
            catch (e) { say(e.message, "err"); }
          } }, "吊销")));
    });
    view.replaceChildren(
      el("h2", {}, "现有 token"),
      el("div", { class: "row" }, el("button", { class: "ghost", onclick: function () { renderTokens(view); } }, "刷新")),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "用户"), el("th", {}, "备注"), el("th", {}, "创建"), el("th", {}, ""))),
        el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: "4", class: "muted" }, "还没有 token")))),
      tokenForm(view)
    );
  } catch (e) { box.replaceChildren(el("p", { class: "muted" }, e.message)); }
}

function tokenForm(view) {
  const label = el("input", { placeholder: "备注，例如：家里电脑" });
  const out = el("div", { class: "up" });
  const go = async function () {
    try {
      const d = await jpost("/admin/api/tokens", { label: label.value });
      out.replaceChildren(
        el("div", {}, "新建的 token（只显示这一次）："),
        el("code", {}, d.token),
        el("div", { class: "muted" }, "安装命令行工具（放进 PATH 里任意目录）："),
        el("code", {}, "curl -fsSL " + location.origin + BASE + "/filebox -o filebox && chmod +x filebox"),
        el("div", { class: "muted" }, "然后 export FILEBOX_TOKEN=上面的 token，运行 filebox whoami 检查一下。以后用 filebox update 升级。")
      );
    } catch (e) { say(e.message, "err"); }
  };
  return el("div", {},
    el("h2", {}, "生成 token"),
    el("div", { class: "row" }, label, el("button", { onclick: go }, "生成")),
    out);
}

// ── 用户（管理员） ──
async function renderUsers(view) {
  const box = el("div", {}, el("p", { class: "muted" }, "加载中…"));
  view.replaceChildren(box);
  try {
    const data = await api("/admin/api/users");
    const rows = data.users.map(function (u) {
      return el("tr", {},
        el("td", {}, u.name),
        el("td", {}, u.role === "admin" ? "管理员" : "普通"),
        el("td", { class: "muted" }, u.disabled ? "已停用" : "正常"),
        el("td", { class: "actions" },
          el("button", { class: "ghost", onclick: function () { changePwd(u.name); } }, "改口令"),
          " ",
          el("button", { class: "ghost", onclick: async function () {
            try {
              await jpost("/admin/api/users/" + encodeURIComponent(u.name) + "/" + (u.disabled ? "enable" : "disable"));
              renderUsers(view);
            } catch (e) { say(e.message, "err"); }
          } }, u.disabled ? "启用" : "停用"),
          " ",
          el("button", { class: "danger", onclick: async function () {
            if (!confirm("删除用户 " + u.name + " 及其全部文件和 token？")) return;
            try { await api("/admin/api/users/" + encodeURIComponent(u.name), { method: "DELETE" }); renderUsers(view); }
            catch (e) { say(e.message, "err"); }
          } }, "删除")));
    });
    view.replaceChildren(
      el("h2", {}, "用户"),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "用户名"), el("th", {}, "角色"), el("th", {}, "状态"), el("th", {}, ""))),
        el("tbody", {}, rows)),
      addUserForm(view)
    );
  } catch (e) { box.replaceChildren(el("p", { class: "muted" }, e.message)); }
}

function addUserForm(view) {
  const u = el("input", { placeholder: "新用户名" });
  const p = el("input", { type: "password", placeholder: "口令（至少 8 位）" });
  const r = el("select", {}, el("option", { value: "user" }, "普通用户"), el("option", { value: "admin" }, "管理员"));
  const go = async function () {
    try {
      await jpost("/admin/api/users", { username: u.value, password: p.value, role: r.value });
      say("已创建 " + u.value);
      renderUsers(view);
    } catch (e) { say(e.message, "err"); }
  };
  return el("div", {},
    el("h2", {}, "新建用户"),
    el("div", { class: "row" }, u, p, r, el("button", { onclick: go }, "创建")));
}

async function changePwd(name) {
  const p = prompt("为 " + name + " 设置新口令（至少 8 位）。该账号的会话和 token 会全部失效。");
  if (!p) return;
  try {
    await jpost("/admin/api/users/" + encodeURIComponent(name) + "/password", { password: p });
    if (name === ME.user) { location.reload(); return; }
    say("口令已更新，" + name + " 的 token 已全部吊销");
  } catch (e) { say(e.message, "err"); }
}

route();
</script>
</body></html>`;
}
