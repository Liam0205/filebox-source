// 用户与 token 的 KV 存储。
//
// 键空间：
//   user:<name>     → { name, salt, hash, iterations, role, created, disabled }
//   token:<sha256>  → { user, label, created }
//
// 规模很小（个位数到几十个用户），所以不做索引表，列用户用 KV list。

const USER_PREFIX = "user:";
const TOKEN_PREFIX = "token:";

export async function getUser(env, name) {
  const raw = await env.USERS.get(USER_PREFIX + name, "json");
  return raw ?? null;
}

export async function putUser(env, record) {
  await env.USERS.put(USER_PREFIX + record.name, JSON.stringify(record));
}

export async function deleteUser(env, name) {
  await env.USERS.delete(USER_PREFIX + name);
}

export async function listUsers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.USERS.list({ prefix: USER_PREFIX, cursor });
    for (const k of page.keys) {
      const rec = await env.USERS.get(k.name, "json");
      if (rec) out.push(publicUser(rec));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function publicUser(u) {
  return {
    name: u.name,
    role: u.role,
    created: u.created,
    disabled: Boolean(u.disabled),
  };
}

// ── token ─────────────────────────────────────────────────────────────

export async function putToken(env, key, record) {
  await env.USERS.put(key, JSON.stringify(record));
}

export async function getToken(env, key) {
  return (await env.USERS.get(key, "json")) ?? null;
}

export async function deleteToken(env, key) {
  await env.USERS.delete(key);
}

export async function listTokens(env, user) {
  const out = [];
  let cursor;
  do {
    const page = await env.USERS.list({ prefix: TOKEN_PREFIX, cursor });
    for (const k of page.keys) {
      const rec = await env.USERS.get(k.name, "json");
      if (!rec) continue;
      if (user && rec.user !== user) continue;
      out.push({ key: k.name, user: rec.user, label: rec.label, created: rec.created });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// 登录限流不在这里做：每次失败都写 KV 会让分布式爆破耗光每天 1,000 次的
// 免费写入额度。限流交给 zone 上的速率限制规则。
