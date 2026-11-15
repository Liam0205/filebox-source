// 共用的响应构造。

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const COMMON = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...COMMON, ...extra },
  });
}

export function text(msg, status = 200, extra = {}) {
  return new Response(`${msg}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...COMMON, ...extra },
  });
}

export function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...COMMON, ...extra },
  });
}

export function methodNotAllowed() {
  return text("Method Not Allowed", 405, { allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS" });
}

export function notFound(cfg) {
  return text(`可用路径：${cfg.basePath}/  ·  ${cfg.basePath}/admin  ·  ${cfg.basePath}/f/<用户>/<路径>`, 404);
}

// JSON 请求体上限。账号和目录接口的正文都很小，超过就拒绝，
// 免得一个巨大的请求体把 Worker 的 128 MB 内存撑爆。
const MAX_JSON_BYTES = 16 * 1024;

// 读取 JSON 请求体；内容类型不对、过大或解析失败时返回 null。
export async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  const raw = await readText(request, MAX_JSON_BYTES);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 读取文本请求体，超过 limit 字节返回 null。
export async function readText(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return null;

  // 没有 Content-Length（chunked）时边读边数。
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
