// 文件索引。KV 里记「用户 + 虚拟路径 → GitHub 资源 id」，GitHub 只当字节仓库。
//
// 键空间（与 users.js 共用 USERS 命名空间）：
//   file:<user>:<encodeURIComponent(path)> → { path, assetId, assetName, size, type, created, keep? }
//   dir:<user>:<encodeURIComponent(path)>  → { created }
//
// 文件键另带 metadata { a: assetId, s: size, c: created, t: type, k?: 1 }。
// KV list 会把 metadata 一起返回，所以列文件、统计长期文件、挑最旧的文件
// 都只花一次 list，不必逐条 get；没有 metadata 的旧记录才回退到 get。
//
// 目录是可空的显式记录；文件路径隐含的目录不需要单独记录。

const FILE_PREFIX = "file:";
const DIR_PREFIX = "dir:";

export function fileKey(user, path) {
  return `${FILE_PREFIX}${user}:${encodeURIComponent(path)}`;
}

export function dirKey(user, path) {
  return `${DIR_PREFIX}${user}:${encodeURIComponent(path)}`;
}

// KV 键上限 512 字节。中文每个字编码后占 9 字节，300 字的路径远超上限，
// 所以要在上传到 GitHub 之前就检查，否则会留下没有索引的孤儿资产。
const KV_KEY_LIMIT = 512;

export function keyFits(user, path) {
  // 目录子项会在键后再拼 "%2F…"，留一点余量。
  return fileKey(user, path).length <= KV_KEY_LIMIT - 8;
}

export async function getFile(env, user, path) {
  return (await env.USERS.get(fileKey(user, path), "json")) ?? null;
}

export async function putFile(env, user, record) {
  await env.USERS.put(fileKey(user, record.path), JSON.stringify(record), {
    metadata: fileMeta(record),
  });
}

// metadata 上限 1024 字节。type 是上传者给的，截断后才放进去。
function fileMeta(rec) {
  const m = { a: rec.assetId, s: rec.size, c: rec.created, t: String(rec.type || "").slice(0, 200) };
  if (rec.keep) m.k = 1;
  return m;
}

function fromMeta(path, m) {
  return { path, assetId: m.a, size: m.s, created: m.c, type: m.t, keep: Boolean(m.k) };
}

export async function deleteFileRecord(env, user, path) {
  await env.USERS.delete(fileKey(user, path));
}

export async function getDir(env, user, path) {
  return (await env.USERS.get(dirKey(user, path), "json")) ?? null;
}

export async function putDir(env, user, path) {
  await env.USERS.put(dirKey(user, path), JSON.stringify({ created: new Date().toISOString() }));
}

export async function deleteDirRecord(env, user, path) {
  await env.USERS.delete(dirKey(user, path));
}

async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.USERS.list({ prefix, cursor });
    for (const k of page.keys) keys.push(k);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

function decodeKeyPath(key, prefix) {
  const raw = key.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// 把一批文件键还原成记录：有 metadata 的直接用，没有的再 get。
async function filesFromKeys(env, keys, prefixOf) {
  const out = [];
  const missing = [];
  for (const k of keys) {
    const path = decodeKeyPath(k.name, prefixOf(k.name));
    if (path == null) continue;
    if (k.metadata && k.metadata.a != null) out.push({ key: k.name, rec: fromMeta(path, k.metadata) });
    else missing.push(k.name);
  }
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const recs = await Promise.all(chunk.map((name) => env.USERS.get(name, "json")));
    recs.forEach((rec, j) => {
      if (rec) out.push({ key: chunk[j], rec: { ...rec, keep: Boolean(rec.keep) } });
    });
  }
  return out;
}

// 一个用户的全部条目。
export async function listUser(env, user) {
  const filePrefix = `${FILE_PREFIX}${user}:`;
  const dirPrefix = `${DIR_PREFIX}${user}:`;
  const [fileKeys, dirKeys] = await Promise.all([
    listKeys(env, filePrefix),
    listKeys(env, dirPrefix),
  ]);

  const files = (await filesFromKeys(env, fileKeys, () => filePrefix)).map((x) => x.rec);

  const dirs = [];
  for (const k of dirKeys) {
    const path = decodeKeyPath(k.name, dirPrefix);
    if (path) dirs.push(path);
  }

  files.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  dirs.sort();
  return { files, dirs };
}

// 全站文件，给自动清理和长期文件计数用：[{ user, path, assetId, created, keep }]。
// 用户名不含 ":"（见 NAME_RE），所以 "file:" 后第一个 ":" 就是用户名的结尾。
export async function listAllFiles(env) {
  const keys = await listKeys(env, FILE_PREFIX);
  const prefixOf = (name) => name.slice(0, name.indexOf(":", FILE_PREFIX.length) + 1);
  return (await filesFromKeys(env, keys, prefixOf)).map(({ key, rec }) => ({
    user: key.slice(FILE_PREFIX.length, key.indexOf(":", FILE_PREFIX.length)),
    path: rec.path,
    assetId: rec.assetId,
    created: rec.created,
    keep: rec.keep,
  }));
}

// 目录非空判定：只要存在位于其下的文件或子目录，就不算空。
// 键里的 / 是 %2F，所以子项的键前缀是 "<目录键>%2F"。
export async function dirHasChildren(env, user, path) {
  const filePrefix = `${fileKey(user, path)}%2F`;
  const dirPrefix = `${DIR_PREFIX}${user}:${encodeURIComponent(path)}%2F`;
  const [filePage, dirPage] = await Promise.all([
    env.USERS.list({ prefix: filePrefix, limit: 1 }),
    env.USERS.list({ prefix: dirPrefix, limit: 1 }),
  ]);
  return filePage.keys.length > 0 || dirPage.keys.length > 0;
}
