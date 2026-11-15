// 口令哈希、会话签名、token 摘要。
//
// 口令用 PBKDF2-SHA256。迭代次数是配置项：免费版 Worker 每次请求只有
// 10ms CPU 预算，迭代次数要和这个上限折中。登录是低频操作，但也不能
// 慢到被直接杀掉。

const enc = new TextEncoder();

// ── base64url ─────────────────────────────────────────────────────────

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(n) {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 口令 ──────────────────────────────────────────────────────────────

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return b64url(bits);
}

// 盐按 hex 存，PBKDF2 要原始字节。
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password, iterations) {
  const salt = randomHex(16);
  const hash = await pbkdf2(password, hexToBytes(salt), iterations);
  return { salt, hash, iterations };
}

export async function verifyPassword(password, record) {
  if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") {
    return false;
  }
  let computed;
  try {
    computed = await pbkdf2(password, hexToBytes(record.salt), record.iterations);
  } catch {
    return false;
  }
  return safeEqualStr(computed, record.hash);
}

// ── 常量时间比较 ───────────────────────────────────────────────────────

export function safeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── 会话 cookie ────────────────────────────────────────────────────────
//
// 无状态：payload 里带用户名和过期时间，用 HMAC 签名。不写 KV，
// 所以登录本身不消耗每日写配额。

const SESSION_MAX_AGE = 7 * 24 * 3600;

export const SESSION_COOKIE = "fb_session";

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function readSession(secret, value) {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, unb64url(sig), enc.encode(body));
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (!payload || typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    // 伪造或损坏的签名不应变成 500。
    return null;
  }
}

export function sessionPayload(user, role, ver) {
  return {
    u: user,
    r: role,
    // 账号版本：改口令时自增，旧会话和旧 token 一起失效。
    v: ver || 0,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
}

// ── 分段上传的回执 ─────────────────────────────────────────────────────
//
// 大文件一段一段上传，每段传完 Worker 返回一张签名回执，最后客户端把回执
// 交回来，Worker 校验后才写索引。这样中间不用写 KV，也不用信任客户端报的资产 id。
// 签名的消息带 "receipt:" 前缀，和会话 cookie 的签名区分开，两者不能互相冒用。

const RECEIPT_DOMAIN = "receipt:";

export async function signReceipt(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(RECEIPT_DOMAIN + body));
  return `${body}.${b64url(sig)}`;
}

export async function readReceipt(secret, value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      unb64url(parts[1]),
      enc.encode(RECEIPT_DOMAIN + parts[0]),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    if (!payload || typeof payload.e !== "number") return null;
    if (payload.e < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(cfg, value) {
  const attrs = [
    `fb_session=${value}`,
    `Path=${cfg.basePath || "/"}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  return attrs.join("; ");
}

export function clearCookie(cfg) {
  return `fb_session=; Path=${cfg.basePath || "/"}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// Authorization: Bearer <token>。不接受查询串里的凭据。
export function bearerToken(request) {
  const raw = (request.headers.get("authorization") || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  return m ? m[1] : null;
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ── API token ─────────────────────────────────────────────────────────
//
// KV 里只存 token 的 SHA-256，即使 KV 被导出也拿不到可用的 token。

export function newToken() {
  return `fb_${randomHex(24)}`;
}

export async function tokenKey(token) {
  return `token:${await sha256Hex(token)}`;
}
