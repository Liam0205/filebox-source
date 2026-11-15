// 文件管理 API（需要身份：token 或管理页会话）。
//
//   GET    /api/whoami                   当前身份，给命令行验证 token 用（/api/me 是旧名字）
//   GET    /api/files[?user=]            自己名下的文件和目录
//   POST   /api/upload?path=...          上传（?overwrite=1 覆盖），一次请求最多 partBytes 字节
//   GET    /api/upload/limits            分段大小和单文件上限
//   POST   /api/upload/part?path=&id=&n=&of=&size=   上传第 n 段，返回签名回执
//   POST   /api/upload/complete?path=... 交回全部回执（一行一张），写索引
//   DELETE /api/file?path=...            删除文件
//   POST   /api/folder                   新建目录 { "path": "a/b" }
//   DELETE /api/folder?path=...          删除空目录
//   POST   /api/keep?path=...            设为长期（不参与自动清理）
//   DELETE /api/keep?path=...            取消长期
//
// 管理员可以用 ?user= 操作别人的文件；普通用户只能操作自己的。
//
// whoami、files、url、upload 系列、keep 接受 ?format=text，返回纯文本，给命令行用：
// 客户端要能在 macOS 自带的 Bash 3.2 上跑，不能指望有 JSON 解析工具。

import { json, methodNotAllowed, readJson, readText, text } from "./http.js";
import {
  basename,
  encodePath,
  extAllowed,
  isPathSegments,
  isUnder,
  listDir,
} from "./names.js";
import { randomHex, readReceipt, sha256Hex, signReceipt } from "./auth.js";
import { deleteAssets, uploadAsset } from "./github.js";
import {
  assetIdsOf,
  deleteDirRecord,
  dirHasChildren,
  getFile,
  keyFits,
  listAllFiles,
  listUser,
  putDir,
  putFile,
} from "./store.js";
import { getUser } from "./users.js";
import { MAX_PARTS } from "./config.js";
import { evict, purgeFile } from "./evict.js";

export function fileUrl(cfg, user, path, assetId) {
  const base = `${cfg.basePath}/f/${encodeURIComponent(user)}/${encodePath(path)}`;
  return assetId ? `${base}?v=${encodeURIComponent(String(assetId))}` : base;
}

function publicFile(cfg, user, rec) {
  return {
    path: rec.path,
    size: rec.size,
    type: rec.type,
    created: rec.created,
    keep: Boolean(rec.keep),
    parts: assetIdsOf(rec).length,
    url: fileUrl(cfg, user, rec.path, rec.assetId),
  };
}

function cacheRequest(cfg, user, path, assetId) {
  return new Request(
    `${cfg.cacheOrigin}/f/${encodeURIComponent(user)}/${encodePath(path)}?v=${assetId}`,
  );
}

const assetCount = (files) => files.reduce((n, f) => n + assetIdsOf(f).length, 0);

// 解析操作对象：默认自己，管理员可用 ?user= 指定他人。
async function targetUser(url, env, actor) {
  const wanted = url.searchParams.get("user");
  if (!wanted || wanted === actor.user) return { user: actor.user };
  if (actor.role !== "admin") return { error: "只能操作自己的文件", status: 403 };
  if (!(await getUser(env, wanted))) return { error: "没有这个用户", status: 404 };
  return { user: wanted };
}

export async function handleFilesApi(request, env, cfg, route, url, actor) {
  if (route === "whoami" || route === "me") {
    if (request.method !== "GET") return methodNotAllowed();
    if (wantsText(url)) {
      const role = actor.role === "admin" ? "管理员" : "普通用户";
      const via = actor.via === "token"
        ? `token${actor.token.label ? `「${actor.token.label}」` : ""}，创建于 ${String(actor.token.created).slice(0, 10)}`
        : "管理页会话";
      return text(`${actor.user}（${role}），通过 ${via}`);
    }
    return json({
      user: actor.user,
      role: actor.role,
      via: actor.via,
      ...(actor.token ? { token: actor.token } : {}),
    });
  }

  if (route === "files") {
    if (request.method !== "GET") return methodNotAllowed();
    const t = await targetUser(url, env, actor);
    if (t.error) return json({ error: t.error }, t.status);

    const { files, dirs } = await listUser(env, t.user);
    const limits = {
      files: files.length,
      assets: assetCount(files),
      maxAssets: cfg.maxAssetsPerUser,
      keep: files.filter((f) => f.keep).length,
      maxKeep: cfg.maxKeepPerUser,
    };
    if (wantsText(url)) {
      // 命令行的 ls：?dir= 只列这个目录下一层（默认根目录），加 recursive=1 列出它下面的
      // 全部文件和显式目录。第一行的用量总是全账号的，路径总是完整路径，方便直接拿去 get/rm。
      const dir = (url.searchParams.get("dir") || "").replace(/^\/+|\/+$/g, "");
      if (dir && !isPathSegments(dir, cfg)) return json({ error: "目录路径不合法" }, 400);
      const level = listDir(files, dirs, dir);
      if (!level.exists) return json({ error: `没有这个目录：${dir}` }, 404);
      const shown =
        url.searchParams.get("recursive") === "1"
          ? { dirs: dirs.filter((d) => isUnder(d, dir)), files: files.filter((f) => isUnder(f.path, dir)) }
          : level;
      // 路径不含控制字符（见 isPathSegments），一行一项不会串行。
      const lines = [
        `${t.user}：${limits.files} 个文件，占用名额 ${limits.assets}/${limits.maxAssets}，长期 ${limits.keep}/${limits.maxKeep} 个`,
      ];
      for (const d of shown.dirs) lines.push(`  dir                          ${d}`);
      for (const f of shown.files) {
        const mark = f.keep ? "keep" : "    ";
        lines.push(`  ${String(f.size).padStart(10)}  ${String(f.created).slice(0, 10)}  ${mark}  ${f.path}`);
      }
      return text(lines.join("\n"));
    }
    return json({
      user: t.user,
      limits,
      files: files.map((f) => publicFile(cfg, t.user, f)),
      dirs,
    });
  }

  // 给命令行用：按路径换取可直接下载的绝对地址。
  if (route === "url") {
    if (request.method !== "GET") return methodNotAllowed();
    const path = url.searchParams.get("path") || "";
    if (!isPathSegments(path, cfg)) return json({ error: "路径不合法" }, 400);
    const rec = await getFile(env, actor.user, path);
    if (!rec) return json({ error: "没有这个文件" }, 404);
    const abs = `${url.origin}${fileUrl(cfg, actor.user, path, rec.assetId)}`;
    if (wantsText(url)) return text(abs);
    return json({
      path,
      url: abs,
      size: rec.size,
      type: rec.type,
    });
  }

  if (route === "upload/limits") {
    if (request.method !== "GET") return methodNotAllowed();
    if (wantsText(url)) return text(`${cfg.partBytes} ${cfg.maxFileBytes}`);
    return json({ partBytes: cfg.partBytes, maxFileBytes: cfg.maxFileBytes, maxParts: MAX_PARTS });
  }

  if (route === "upload") {
    if (request.method !== "POST" && request.method !== "PUT") return methodNotAllowed();
    return upload(request, env, cfg, url, actor);
  }

  if (route === "upload/part") {
    if (request.method !== "POST" && request.method !== "PUT") return methodNotAllowed();
    return uploadPart(request, env, cfg, url, actor);
  }

  if (route === "upload/complete") {
    if (request.method !== "POST") return methodNotAllowed();
    return completeUpload(request, env, cfg, url, actor);
  }

  if (route === "file") {
    if (request.method !== "DELETE") return methodNotAllowed();
    return remove(request, env, cfg, url, actor);
  }

  if (route === "keep") {
    if (request.method === "POST") return setKeep(env, cfg, url, actor, true);
    if (request.method === "DELETE") return setKeep(env, cfg, url, actor, false);
    return methodNotAllowed();
  }

  if (route === "folder") {
    if (request.method === "POST") return makeFolder(request, env, cfg, url, actor);
    if (request.method === "DELETE") return removeFolder(request, env, cfg, url, actor);
    return methodNotAllowed();
  }

  return json({ error: "没有这个接口" }, 404);
}

function wantsText(url) {
  return url.searchParams.get("format") === "text";
}

// 路径、扩展名、键长的公共检查。不合格返回错误响应，合格返回 null。
function checkPath(cfg, user, path) {
  if (!isPathSegments(path, cfg)) {
    return json(
      { error: "路径不合法：不能以 / 开头或结尾，不能含 . / .. 段或控制字符，长度和层数有上限" },
      400,
    );
  }
  if (!extAllowed(basename(path), cfg.allowedExt)) {
    return json({ error: `不允许的扩展名，仅接受：${cfg.allowedExt.join(", ")}` }, 415);
  }
  // 键长必须在上传到 GitHub 之前检查，否则写不进索引，资产就成了孤儿。
  if (!keyFits(user, path)) {
    return json({ error: "路径过长（非 ASCII 字符按编码后长度计算）" }, 414);
  }
  return null;
}

function bodyLength(request) {
  const length = Number(request.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? length : null;
}

// 把请求体传成一个资产。422 时先清理一批再返回 507，让客户端重传。
// 成功返回 { asset }，失败返回 { response }。
async function putAsset(env, cfg, request, user, label, contentType, length) {
  try {
    const asset = await uploadAsset(cfg, {
      name: `fb_${user}_${randomHex(12)}`,
      label: label.length <= 120 ? label : label.slice(-120),
      body: request.body,
      contentType,
      contentLength: length,
    });
    return { asset };
  } catch (err) {
    // 422 多半是 release 的资产数到了 1000（GitHub 没有文档说明满了返回什么）。
    // 请求体已经读掉了，没法在这里重试；先清理一批，让客户端重新上传。
    if (err.status === 422) {
      const r = await evict(env, cfg, 10).catch(() => ({ deleted: [] }));
      console.log(JSON.stringify({ uploadFull: true, evicted: r.deleted }));
      return {
        response: json(
          {
            error: r.deleted.length
              ? `GitHub release 已满，已自动清理 ${r.deleted.length} 个最旧的文件，请重新上传`
              : "GitHub release 已满（最多 1000 个资产），而且没有可以自动清理的文件",
            evicted: r.deleted.length,
          },
          507,
        ),
      };
    }
    return { response: json({ error: err.message }, 502) };
  }
}

// 写索引，覆盖时删掉旧文件的资产。新资产已经就位、索引已经指向新 id，旧资产才可以删。
async function commitRecord(env, cfg, user, record, existing) {
  // 覆盖上传保留长期标记。
  if (existing && existing.keep) record.keep = true;
  await putFile(env, user, record);

  if (existing) {
    // 旧资产删不掉只是留下孤儿，由对账任务收拾，不影响新文件。
    await deleteAssets(cfg, assetIdsOf(existing));
    if (cfg.cacheEnabled) {
      await caches.default
        .delete(cacheRequest(cfg, user, record.path, existing.assetId))
        .catch(() => {});
    }
  }
}

function created(url, cfg, user, record) {
  if (wantsText(url)) {
    return text(`${url.origin}${fileUrl(cfg, user, record.path, record.assetId)}`, 201);
  }
  return json({ file: publicFile(cfg, user, record) }, 201);
}

async function upload(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || url.searchParams.get("name") || "";
  const bad = checkPath(cfg, actor.user, path);
  if (bad) return bad;

  const length = bodyLength(request);
  if (!length) {
    return json({ error: "上传需要 Content-Length（请勿使用 chunked 请求体）" }, 411);
  }
  if (length > cfg.partBytes) {
    return json(
      {
        error: `一次请求最多 ${cfg.partBytes} 字节，当前 ${length} 字节；更大的文件要分段上传（新版命令行和网页会自动分段）`,
        partBytes: cfg.partBytes,
      },
      413,
    );
  }
  if (!request.body) return json({ error: "请求体为空" }, 400);

  const overwrite = url.searchParams.get("overwrite") === "1";
  const existing = await getFile(env, actor.user, path);
  if (existing && !overwrite) {
    return json({ error: "同名文件已存在", hint: "加 ?overwrite=1 覆盖" }, 409);
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const r = await putAsset(env, cfg, request, actor.user, path, contentType, length);
  if (r.response) return r.response;

  const record = {
    path,
    assetId: r.asset.id,
    assetName: r.asset.name,
    size: r.asset.size,
    type: r.asset.content_type || contentType,
    created: new Date().toISOString(),
  };
  await commitRecord(env, cfg, actor.user, record, existing);
  return created(url, cfg, actor.user, record);
}

// ── 分段上传 ────────────────────────────────────────────────────────────
//
// 客户端先 GET /api/upload/limits 拿到段长，把文件切成 of 段（除最后一段外每段
// 都是 partBytes），随机取一个上传 id，逐段 POST /api/upload/part，每段换回一张
// 回执；最后把回执按行 POST 到 /api/upload/complete。
//
// 中间不写 KV：回执里签了用户、路径、上传 id、段号、段数、总长、资产 id 和段长，
// complete 只要验签、核对就能写索引。回执在孤儿判定时长之前过期，
// 所以中断的上传留下的段，会被对账任务当作孤儿删掉，不会再被人提交。

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// 回执约 300 字节，MAX_PARTS 张加换行也远小于这个数。
const MAX_RECEIPTS_BYTES = 32 * 1024;

function intParam(url, name) {
  const v = url.searchParams.get(name);
  return v != null && /^[0-9]{1,12}$/.test(v) ? Number(v) : null;
}

// 回执里存路径的摘要而不是路径本身，回执长度就跟路径无关。
const pathTag = async (path) => (await sha256Hex(path)).slice(0, 32);

async function uploadPart(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || "";
  const bad = checkPath(cfg, actor.user, path);
  if (bad) return bad;

  const id = url.searchParams.get("id") || "";
  const n = intParam(url, "n");
  const of = intParam(url, "of");
  const size = intParam(url, "size");
  if (!UPLOAD_ID_RE.test(id)) return json({ error: "上传 id 不合法" }, 400);
  if (of == null || of < 2 || of > MAX_PARTS || n == null || n < 1 || n > of) {
    return json({ error: `段号不合法，段数要在 2 到 ${MAX_PARTS} 之间` }, 400);
  }
  if (size == null || size > cfg.maxFileBytes) {
    return json({ error: `单文件上限 ${cfg.maxFileBytes} 字节` }, 413);
  }
  // 段数和段长都由总长决定，客户端算错了就直接拒绝，免得传完才发现拼不起来。
  if (Math.ceil(size / cfg.partBytes) !== of) {
    return json({ error: `按段长 ${cfg.partBytes} 字节，${size} 字节应该分 ${Math.ceil(size / cfg.partBytes)} 段`, partBytes: cfg.partBytes }, 400);
  }
  const expect = n < of ? cfg.partBytes : size - cfg.partBytes * (of - 1);
  const length = bodyLength(request);
  if (length !== expect) {
    return json({ error: `第 ${n} 段应该是 ${expect} 字节，收到 ${length || "未知长度"}` }, 400);
  }
  if (!request.body) return json({ error: "请求体为空" }, 400);

  const r = await putAsset(env, cfg, request, actor.user, `${path} (${n}/${of})`, "application/octet-stream", length);
  if (r.response) return r.response;
  if (r.asset.size !== expect) {
    // GitHub 收到的字节数不对，这一段不能用。
    await deleteAssets(cfg, [r.asset.id]);
    return json({ error: `第 ${n} 段写入 GitHub 后长度不对（${r.asset.size}）` }, 502);
  }

  const receipt = await signReceipt(cfg.sessionSecret, {
    u: actor.user,
    p: await pathTag(path),
    i: id,
    n,
    of,
    z: size,
    a: r.asset.id,
    s: r.asset.size,
    e: Math.floor(Date.now() / 1000) + cfg.receiptSeconds,
  });
  if (wantsText(url)) return text(receipt, 201);
  return json({ receipt, n, of }, 201);
}

async function completeUpload(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || "";
  const bad = checkPath(cfg, actor.user, path);
  if (bad) return bad;

  const raw = await readText(request, MAX_RECEIPTS_BYTES);
  if (raw == null) return json({ error: "回执太长或者请求体为空" }, 400);
  const lines = raw.split(/\s+/).filter(Boolean);

  const tag = await pathTag(path);
  const parts = [];
  for (const line of lines) {
    const r = await readReceipt(cfg.sessionSecret, line);
    if (!r) return json({ error: "回执无效或已过期，请重新上传" }, 400);
    if (r.u !== actor.user || r.p !== tag) return json({ error: "回执与用户或路径不符" }, 400);
    parts.push(r);
  }
  if (!parts.length) return json({ error: "没有回执" }, 400);

  // 所有回执必须来自同一次上传，段号 1..of 各一张，总长对得上。
  const first = parts[0];
  const same = parts.every((r) => r.i === first.i && r.of === first.of && r.z === first.z);
  if (!same || parts.length !== first.of) return json({ error: "回执不是同一次上传的，或者缺段" }, 400);
  parts.sort((a, b) => a.n - b.n);
  if (parts.some((r, k) => r.n !== k + 1)) return json({ error: "段号不连续" }, 400);
  const total = parts.reduce((s, r) => s + r.s, 0);
  if (total !== first.z) return json({ error: `各段加起来 ${total} 字节，应为 ${first.z}` }, 400);

  const overwrite = url.searchParams.get("overwrite") === "1";
  const existing = await getFile(env, actor.user, path);
  if (existing && !overwrite) {
    // 段已经传上去了，不删的话会变成孤儿，这里顺手删掉。
    await deleteAssets(cfg, parts.map((r) => r.a));
    return json({ error: "同名文件已存在", hint: "加 ?overwrite=1 覆盖" }, 409);
  }
  // 同一组回执提交两次：索引已经指向这些段，再写一遍会在覆盖时把它们删掉。
  if (existing && String(existing.assetId) === String(first.a)) {
    return created(url, cfg, actor.user, existing);
  }

  const record = {
    path,
    assetId: first.a,
    parts: parts.map((r) => ({ a: r.a, s: r.s })),
    size: total,
    type: request.headers.get("x-file-type") || "application/octet-stream",
    created: new Date().toISOString(),
  };
  // 类型来自客户端，长度和字符都收紧一点再存。
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(record.type) || record.type.length > 200) {
    record.type = "application/octet-stream";
  }
  await commitRecord(env, cfg, actor.user, record, existing);
  return created(url, cfg, actor.user, record);
}

async function remove(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || url.searchParams.get("name") || "";
  if (!isPathSegments(path, cfg)) return json({ error: "路径不合法" }, 400);

  const t = await targetUser(url, env, actor);
  if (t.error) return json({ error: t.error }, t.status);

  const rec = await getFile(env, t.user, path);
  if (!rec) return json({ error: "没有这个文件" }, 404);

  try {
    await purgeFile(env, cfg, t.user, rec);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  if (cfg.cacheEnabled) {
    await caches.default.delete(cacheRequest(cfg, t.user, path, rec.assetId)).catch(() => {});
  }
  return json({ deleted: path });
}

// 长期文件不参与自动清理。数量有上限：每人 maxKeepPerUser 个文件，
// 全站长期文件最多占 maxKeepTotal 个名额（大文件一段占一个）。
// 计数靠一次 KV list（带 metadata），在 KV 的一致性窗口内并发设置可能略超上限。
async function setKeep(env, cfg, url, actor, on) {
  const path = url.searchParams.get("path") || "";
  if (!isPathSegments(path, cfg)) return json({ error: "路径不合法" }, 400);

  const t = await targetUser(url, env, actor);
  if (t.error) return json({ error: t.error }, t.status);

  const rec = await getFile(env, t.user, path);
  if (!rec) return json({ error: "没有这个文件" }, 404);

  if (Boolean(rec.keep) !== on) {
    if (on) {
      const all = await listAllFiles(env);
      const mine = all.filter((f) => f.keep && f.user === t.user).length;
      if (mine >= cfg.maxKeepPerUser) {
        return json({ error: `每个用户最多 ${cfg.maxKeepPerUser} 个长期文件，先取消一些再设` }, 409);
      }
      const total = all.filter((f) => f.keep).reduce((n, f) => n + f.assets.length, 0);
      if (total + assetIdsOf(rec).length > cfg.maxKeepTotal) {
        return json({ error: `全站长期文件最多占 ${cfg.maxKeepTotal} 个名额，现在已占 ${total} 个` }, 409);
      }
      rec.keep = true;
    } else {
      delete rec.keep;
    }
    await putFile(env, t.user, rec);
  }

  if (wantsText(url)) return text(on ? `已设为长期：${path}` : `已取消长期：${path}`);
  return json({ path, keep: on });
}

async function folderPath(request, url) {
  const fromQuery = url.searchParams.get("path");
  if (fromQuery != null) return fromQuery;
  const body = await readJson(request);
  return body && typeof body.path === "string" ? body.path : "";
}

async function makeFolder(request, env, cfg, url, actor) {
  const path = await folderPath(request, url);
  if (!isPathSegments(path, cfg)) return json({ error: "目录路径不合法" }, 400);
  if (!keyFits(actor.user, path)) {
    return json({ error: "路径过长（非 ASCII 字符按编码后长度计算）" }, 414);
  }
  if (await getFile(env, actor.user, path)) {
    return json({ error: "同名位置已有文件" }, 409);
  }
  await putDir(env, actor.user, path);
  return json({ dir: path }, 201);
}

async function removeFolder(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || "";
  if (!isPathSegments(path, cfg)) return json({ error: "目录路径不合法" }, 400);

  if (await dirHasChildren(env, actor.user, path)) {
    return json({ error: "目录非空" }, 409);
  }
  await deleteDirRecord(env, actor.user, path);
  return json({ deleted: path });
}
