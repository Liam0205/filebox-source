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

async function call(cfg, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.apiTimeoutMs);
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

  const res = await call(cfg, url, {
    method: "POST",
    headers: h,
    body,
    // 流式请求体在 Workers 里需要显式声明。
    duplex: "half",
    redirect: "follow",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`上传失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
