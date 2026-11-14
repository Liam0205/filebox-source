// 请求身份：API token 或管理页会话。
//
// token 走 Authorization: Bearer，适合脚本；会话走 HttpOnly cookie，适合
// 浏览器。两者最终都落到一个 KV 里的用户记录，并且每次都重新读取，
// 这样停用账号、改角色、删用户能立刻生效（受 KV 一致性窗口限制）。

import {
  SESSION_COOKIE,
  bearerToken,
  readCookie,
  readSession,
  tokenKey,
} from "./auth.js";
import { getToken, getUser } from "./users.js";

export const NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;

// 返回 { user, role, via } 或 { error, status }。
export async function currentActor(request, env, cfg) {
  const token = bearerToken(request);
  if (token) {
    const rec = await getToken(env, await tokenKey(token));
    if (!rec) return { error: "token 无效或已吊销", status: 401 };
    const user = await getUser(env, rec.user);
    if (!user || user.disabled) return { error: "账号不可用", status: 401 };
    if ((rec.v || 0) !== (user.ver || 0)) {
      return { error: "token 已失效，请在管理页重新生成", status: 401 };
    }
    return { user: user.name, role: user.role, via: "token" };
  }

  const payload = await readSession(
    cfg.sessionSecret,
    readCookie(request, SESSION_COOKIE),
  );
  if (!payload) return null;

  const user = await getUser(env, payload.u);
  if (!user || user.disabled) return null;
  if ((payload.v || 0) !== (user.ver || 0)) return null;
  return { user: user.name, role: user.role, via: "session" };
}

// 会话 cookie 由浏览器自动携带，所以对浏览器的写操作要求同源 Origin。
// token 请求不依赖 cookie，不受此限制。
export function sameOrigin(request, url) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl 等非浏览器客户端
  try {
    const o = new URL(origin);
    return o.protocol === url.protocol && o.host === url.host;
  } catch {
    return false;
  }
}
