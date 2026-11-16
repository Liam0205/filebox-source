// 公开下载：GET/HEAD /f/<用户>/<路径>
//
// 下载不需要登录。顺序是「先查 KV 索引，再查边缘缓存」——反过来会让
// 已删除的文件继续从缓存里被端出去。
//
// 缓存键里带 assetId（v 参数），所以覆盖上传会自然换一个键，不需要
// 跨节点失效；代价是旧对象的缓存要等它自己过期。
//
// 分段存储的大文件由 Worker 按顺序向 GitHub 取各段、接成一个流返回。
// Range 请求换算到具体的段，只取用得到的那几段。大文件不进缓存：
// Cache API 单个对象上限 512 MB，而且每次都整段写缓存也太费。
//
// 响应体一律经 FixedLengthStream 交给客户端，在 waitUntil 里 pipeTo，传完或
// 中断时记一行日志（logTransfer），面板里能看到每次下载的字节数和耗时。

import { logTransfer, methodNotAllowed, text } from "./http.js";
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
  const t0 = Date.now();
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

  if (Array.isArray(rec.parts) && rec.parts.length > 1) {
    return serveParts(cfg, ctx, rec, versioned, range, downLog(request, env, user, rec, "BYPASS"), t0);
  }

  if (cache && !range) {
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("cache-control", cacheControl(cfg, versioned));
      headers.set("x-cache", "HIT");
      const body = timed(ctx, hit.body, hit.headers.get("content-length"), downLog(request, env, user, rec, "HIT"), t0);
      return new Response(body, { status: hit.status, headers });
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
  const xcache = cache ? "MISS" : "BYPASS";
  headers.set("x-cache", xcache);

  // 写缓存的那一份从上游分出去，不从给客户端的流分：计时要跟着客户端走，
  // 不能被写缓存的速度带偏。
  if (cache && !range && upstream.status === 200) {
    const stored = new Response(upstream.clone().body, {
      status: 200,
      headers: { ...baseHeaders(cfg, rec, true) },
    });
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
  }

  const log = downLog(request, env, user, rec, xcache, upstream.status);
  const body = timed(ctx, upstream.body, upstream.headers.get("content-length"), log, t0);
  return new Response(body, { status: upstream.status, headers });
}

function downLog(request, env, user, rec, cache, status = 200) {
  return { xfer: "down", user, path: rec.path, status, cache, colo: request.cf?.colo, ds: env.XFER };
}

// 把 body 经 FixedLengthStream 接给客户端，传完或断开时记日志。原生流之间
// pipeTo 不经过 JS，不额外花 CPU（见 serveParts 的注释）。长度不明时原样透传，不计时。
function timed(ctx, body, length, log, t0) {
  const n = Number(length);
  if (!body || !Number.isSafeInteger(n) || n <= 0) return body;
  log = { ...log, wait: Date.now() - t0 };
  const { readable, writable } = new FixedLengthStream(n);
  ctx.waitUntil(
    body.pipeTo(writable).then(
      () => logTransfer(log, n, t0),
      (err) => logTransfer(log, n, t0, err),
    ),
  );
  return readable;
}

// 解析单个区间 bytes=a-b / bytes=a- / bytes=-n。多区间和不合法的写法返回 null，
// 调用方按整文件处理（RFC 9110 允许忽略 Range）。越界返回 "unsatisfiable"。
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size) return "unsatisfiable";
    if (end < start) return null;
  }
  return { start, end };
}

// 纯函数：把 [start, end] 换算成每段要取的区间 [{ index, from, to }]（段内偏移，含两端）。
export function partSlices(sizes, start, end) {
  const out = [];
  let off = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const lo = off;
    const hi = off + sizes[i] - 1;
    off += sizes[i];
    if (hi < start || lo > end) continue;
    out.push({ index: i, from: Math.max(start, lo) - lo, to: Math.min(end, hi) - lo });
  }
  return out;
}

async function serveParts(cfg, ctx, rec, versioned, rangeHeader, log, t0) {
  const sizes = rec.parts.map((p) => p.s);
  const size = rec.size;
  const r = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (r === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  const start = r ? r.start : 0;
  const end = r ? r.end : size - 1;
  const slices = partSlices(sizes, start, end);

  // 先把第一段的连接建好：GitHub 不可用时还能返回 502，而不是一个中途断掉的 200。
  const fetchSlice = async (s) => {
    const whole = s.from === 0 && s.to === sizes[s.index] - 1;
    const res = await assetDownload(cfg, rec.parts[s.index].a, whole ? null : `bytes=${s.from}-${s.to}`);
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`第 ${s.index + 1} 段上游返回 ${res.status}`);
    }
    return res;
  };
  let first;
  try {
    first = await fetchSlice(slices[0]);
  } catch (err) {
    return text(`上游不可达：${err.message}`, 502);
  }

  // 逐段接成一个流。只在上一段读完后才去取下一段，同一时刻只开一个上游连接。
  // 中途出错只能把流断掉，客户端会看到长度不足，可以用 Range 续传。
  //
  // 必须用 FixedLengthStream，不能用 TransformStream：后者是 JS 实现，每个块都
  // 要过一遍 JS，线上实测约 14 ms CPU/MB，一百多 MB 就会因超出 CPU 限制被掐断。
  // FixedLengthStream 是运行时原生的流，原生流之间 pipeTo 不经过 JS；它还让
  // 响应带上 Content-Length，流不足长时连接会报错，客户端不会把半个文件当成完整的。
  const length = end - start + 1;
  const { readable, writable } = new FixedLengthStream(length);
  log = { ...log, status: r ? 206 : 200, parts: slices.length, wait: Date.now() - t0 };
  const pump = async () => {
    try {
      for (let k = 0; k < slices.length; k += 1) {
        const res = k === 0 ? first : await fetchSlice(slices[k]);
        await res.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
      logTransfer(log, length, t0);
    } catch (err) {
      logTransfer(log, length, t0, err);
      await writable.abort(err).catch(() => {});
    }
  };
  // 响应体还在被客户端读的时候，运行时会让 Worker 一直活着；waitUntil 是保险。
  ctx.waitUntil(pump());

  const headers = new Headers(baseHeaders(cfg, rec, versioned));
  headers.set("content-length", String(length));
  headers.set("x-cache", "BYPASS");
  if (r) headers.set("content-range", `bytes ${start}-${end}/${size}`);
  return new Response(readable, { status: r ? 206 : 200, headers });
}
