// 公开下载：GET/HEAD /f/<用户>/<路径>
//
// 下载不需要登录。顺序是「先查 KV 索引，再查边缘缓存」——反过来会让
// 已删除的文件继续从缓存里被端出去。
//
// 缓存键里带 assetId（v 参数），所以覆盖上传会自然换一个键，不需要
// 跨节点失效；代价是旧对象的缓存要等它自己过期。

import { methodNotAllowed, text } from "./http.js";
import { basename, encodePath, isPathSegments } from "./names.js";
import { getFile } from "./store.js";
import { assetDownload } from "./github.js";
import { NAME_RE } from "./access.js";

// GitHub 的资产下载端点统一返回 application/octet-stream，类型以我们上传时
// 记录的为准；这里只从上游取长度和区间信息。
const FORWARD = ["content-length", "content-range"];

// 只有这些类型可以内联展示。其余（尤其是 html/svg/js/xml）一律附件下载，
// 避免用户上传的主动内容以本站 origin 执行。
const INLINE_RE =
  /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/plain|application\/pdf)(;|$)/i;

function cacheKey(cfg, user, path, assetId) {
  return new Request(
    `${cfg.cacheOrigin}/f/${encodeURIComponent(user)}/${encodePath(path)}?v=${assetId}`,
  );
}

function cacheControl(cfg, versioned) {
  return versioned
    ? `public, max-age=${cfg.versionedTtl}, immutable`
    : `public, max-age=${cfg.assetTtl}`;
}

function contentDisposition(name, type) {
  const inline = INLINE_RE.test(type || "");
  const fallback = name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 120);
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function baseHeaders(cfg, rec, versioned) {
  const type = rec.type || "application/octet-stream";
  return {
    "content-type": type,
    "content-length": String(rec.size),
    "accept-ranges": "bytes",
    etag: `"${rec.assetId}"`,
    "last-modified": new Date(rec.created).toUTCString(),
    "cache-control": cacheControl(cfg, versioned),
    "content-disposition": contentDisposition(basename(rec.path), type),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
}

export async function serveFile(request, env, cfg, ctx, user, path, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
  if (!NAME_RE.test(user) || !isPathSegments(path, cfg)) return text("路径不合法", 400);

  const rec = await getFile(env, user, path);
  if (!rec) return text(`没有这个文件：${user}/${path}`, 404);

  const versioned = url.searchParams.get("v") === String(rec.assetId);
  const key = cacheKey(cfg, user, path, rec.assetId);
  const cache = cfg.cacheEnabled && typeof caches !== "undefined" ? caches.default : null;

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders(cfg, rec, versioned), "x-cache": "BYPASS" },
    });
  }

  const range = request.headers.get("range");

  if (cache && !range) {
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("cache-control", cacheControl(cfg, versioned));
      headers.set("x-cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  let upstream;
  try {
    upstream = await assetDownload(cfg, rec.assetId, range);
  } catch (err) {
    return text(`上游不可达：${err.message}`, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return text(`上游返回 ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  }

  const headers = new Headers(baseHeaders(cfg, rec, versioned));
  for (const h of FORWARD) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("x-cache", cache ? "MISS" : "BYPASS");

  const out = new Response(upstream.body, { status: upstream.status, headers });

  if (cache && !range && upstream.status === 200) {
    const stored = new Response(out.clone().body, {
      status: 200,
      headers: { ...baseHeaders(cfg, rec, true) },
    });
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
  }

  return out;
}
