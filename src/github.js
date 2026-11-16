// GitHub Releases 作为字节仓库。
//
// 一个 release 承载所有资产。资源名在 release 内必须唯一，而且 GitHub 会
// 改写名字里的斜杠、中文、空格，所以资源名用不透明 id（fb_<user>_<随机>），
// 人类可读的路径放在 label 和 KV 索引里。

const API = "https://api.github.com";
const UPLOAD = "https://uploads.github.com";

function headers(cfg, extra = {}) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": cfg.userAgent,
    "x-github-api-version": "2022-11-28",
    ...extra,
  };
  if (cfg.githubToken) h.authorization = `Bearer ${cfg.githubToken}`;
  return h;
}

// 超时只算到收到响应头。timeoutMs 为 0 时不设超时，给上传用。
async function call(cfg, url, init = {}, timeoutMs = cfg.apiTimeoutMs) {
  if (!timeoutMs) return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 仓库名和 tag 没有默认值。没配就直接报错：请求打到 /repos//… 会得到 404，
// 而 deleteAsset 把 404 当作已删除，自动清理会因此误删索引。
function repoOf(cfg) {
  if (!cfg.repo || !cfg.releaseTag) throw new Error("没有配置 GITHUB_REPO 或 RELEASE_TAG");
  return cfg.repo;
}

// release 的 id 在进程内记忆，避免每次请求都查一次。
const releaseMemo = new Map();

export async function releaseId(cfg) {
  const key = `${repoOf(cfg)}#${cfg.releaseTag}`;
  const hit = releaseMemo.get(key);
  if (hit) return hit;

  const res = await call(
    cfg,
    `${API}/repos/${cfg.repo}/releases/tags/${encodeURIComponent(cfg.releaseTag)}`,
    { headers: headers(cfg) },
  );
  if (res.status === 404) throw new Error(`release ${cfg.releaseTag} 不存在`);
  if (!res.ok) throw new Error(`查询 release 失败：HTTP ${res.status}`);

  const data = await res.json();
  releaseMemo.set(key, data.id);
  return data.id;
}

// uploads.github.com 只接受带 Content-Length 的请求体，所以调用方要尽量
// 传来 client 声明的长度；拿不到就退化为 chunked（GitHub 可能拒收）。
export async function uploadAsset(cfg, { name, label, body, contentType, contentLength }) {
  const id = await releaseId(cfg);
  const params = new URLSearchParams({ name });
  if (label) params.set("label", label);
  const url = `${UPLOAD}/repos/${cfg.repo}/releases/${id}/assets?${params}`;

  const h = headers(cfg, { "content-type": contentType || "application/octet-stream" });
  delete h.accept;
  if (contentLength) h["content-length"] = String(contentLength);

  // 不设超时：请求体是客户端的流，GitHub 收完才返回响应头，超时会把整段上传
  // 算进去。一段 95 MiB 在 20 秒内传完要 5 MB/s，手机网络常常达不到。
  // 客户端断开时请求体出错，这个请求会跟着失败，不会一直挂着。
  const res = await call(cfg, url, {
    method: "POST",
    headers: h,
    body,
    // 流式请求体在 Workers 里需要显式声明。
    duplex: "half",
    redirect: "follow",
  }, 0);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`上传失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// label 最多 120 个字符，GitHub 对更长的会报错。路径太长时留结尾那段，文件名在里面。
export function assetLabel(label) {
  return label.length <= 120 ? label : label.slice(-120);
}

// 改资产的 label，给重命名用。资产名（fb_…）不动。
export async function setAssetLabel(cfg, assetId, label) {
  const res = await call(cfg, `${API}/repos/${repoOf(cfg)}/releases/assets/${assetId}`, {
    method: "PATCH",
    headers: headers(cfg, { "content-type": "application/json" }),
    body: JSON.stringify({ label: assetLabel(label) }),
  });
  if (!res.ok) throw new Error(`改 label 失败：HTTP ${res.status}`);
}

export async function deleteAsset(cfg, assetId) {
  const res = await call(cfg, `${API}/repos/${repoOf(cfg)}/releases/assets/${assetId}`, {
    method: "DELETE",
    headers: headers(cfg),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`删除失败：HTTP ${res.status}`);
  }
}

// 按顺序删一批资产，遇到错误就停（GitHub 出问题时别把子请求额度耗在失败上）。
// 返回没删掉的 id；调用方通常先删了索引，这些资产会成为孤儿，由对账任务收拾。
export async function deleteAssets(cfg, ids) {
  for (let i = 0; i < ids.length; i += 1) {
    try {
      await deleteAsset(cfg, ids[i]);
    } catch (err) {
      console.log(JSON.stringify({ deleteError: err.message, left: ids.length - i }));
      return ids.slice(i);
    }
  }
  return [];
}

// 列出 release 里的资产，给孤儿对账用：[{ id, name, created }]。
// 每页 100 个，一页花一个外部子请求；release 最多 1000 个资产，10 页就列完。
export async function listAssets(cfg, maxPages = 10) {
  const id = await releaseId(cfg);
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await call(
      cfg,
      `${API}/repos/${repoOf(cfg)}/releases/${id}/assets?per_page=100&page=${page}`,
      { headers: headers(cfg) },
    );
    if (!res.ok) throw new Error(`列资产失败：HTTP ${res.status}`);
    const batch = await res.json();
    for (const a of batch) out.push({ id: a.id, name: a.name, created: a.created_at });
    if (batch.length < 100) return { assets: out, complete: true, pages: page };
  }
  return { assets: out, complete: false, pages: maxPages };
}

// 资产的下载地址不是稳定的公开 URL：私有仓库要先拿一个 302 签名地址。
// 签名地址约 1 小时过期，且指向 release-assets.githubusercontent.com，
// 所以这里手工跟随跳转，避免把 GitHub token 发给另一个域名。
export async function assetDownload(cfg, assetId, range) {
  const h = headers(cfg, { accept: "application/octet-stream" });
  if (range) h.range = range;

  const first = await call(cfg, `${API}/repos/${repoOf(cfg)}/releases/assets/${assetId}`, {
    headers: h,
    redirect: "manual",
  });

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error(`上游重定向缺少 location（HTTP ${first.status}）`);
    // 签名 URL 自带凭据，不能再带 Authorization。
    const plain = { "user-agent": cfg.userAgent };
    if (range) plain.range = range;
    return call(cfg, location, { headers: plain, redirect: "follow" });
  }

  return first;
}
