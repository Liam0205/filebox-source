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

// 一次上传或下载的字节数和耗时，打一行 JSON 进 Workers Logs，面板里可以按字段筛选。
// 耗时是整条链路的：客户端、Cloudflare、GitHub 哪一段慢都会算进来。
// Workers 里 Date.now() 只在 I/O 之后前进，t0 和结束都紧挨着 I/O，误差可以不计。
// 出错时不知道实际传了多少，记的是本该传的长度（size），不算速率。
// 下载带 wait：开始送出字节之前花的时间（查索引、连 GitHub），速率按 ms - wait 算。
// fields.ds 是 Analytics Engine 的绑定（env.XFER），有就再写一个数据点，留着做长期统计
// （Workers Logs 只存 3 天）。字段顺序见 llmdoc/architecture/storage-and-auth.md 的「传输日志」。
export function logTransfer(fields, bytes, t0, err) {
  const { ds, ...rest } = fields;
  const ms = Date.now() - t0;
  const wait = rest.wait || 0;
  const span = ms - wait;
  const error = err ? String(err && err.message ? err.message : err).slice(0, 200) : "";
  const MBps = !err && span > 0 ? Math.round((bytes / 1e6 / (span / 1000)) * 100) / 100 : null;
  if (err) console.log(JSON.stringify({ ...rest, size: bytes, ms, error }));
  else console.log(JSON.stringify({ ...rest, bytes, ms, MBps }));
  if (!ds) return;
  try {
    ds.writeDataPoint({
      indexes: [rest.user || ""],
      blobs: [rest.xfer, rest.user || "", rest.path || "", rest.cache || "", rest.colo || "", error],
      doubles: [bytes, ms, wait, MBps || 0, err ? 0 : 1, rest.status || 0, rest.parts || 0],
    });
  } catch (e) {
    console.log(JSON.stringify({ xferStatsError: String(e && e.message ? e.message : e).slice(0, 200) }));
  }
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
