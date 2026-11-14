// 文件管理 API（需要身份：token 或管理页会话）。
//
//   GET    /api/me
//   GET    /api/files[?user=]            自己名下的文件和目录
//   POST   /api/upload?path=...          上传（?overwrite=1 覆盖）
//   DELETE /api/file?path=...            删除文件
//   POST   /api/folder                   新建目录 { "path": "a/b" }
//   DELETE /api/folder?path=...          删除空目录
//   POST   /api/keep?path=...            设为长期（不参与自动清理）
//   DELETE /api/keep?path=...            取消长期
//
// 管理员可以用 ?user= 操作别人的文件；普通用户只能操作自己的。
//
// files、url、upload 接受 ?format=text，返回纯文本，给命令行用：
// 客户端要能在 macOS 自带的 Bash 3.2 上跑，不能指望有 JSON 解析工具。

import { json, methodNotAllowed, readJson, text } from "./http.js";
import {
  basename,
  encodePath,
  extAllowed,
  isPathSegments,
} from "./names.js";
import { randomHex } from "./auth.js";
import { deleteAsset, uploadAsset } from "./github.js";
import {
  deleteDirRecord,
  deleteFileRecord,
  dirHasChildren,
  getFile,
  keyFits,
  listAllFiles,
  listUser,
  putDir,
  putFile,
} from "./store.js";
import { getUser } from "./users.js";
import { evict } from "./evict.js";

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
    url: fileUrl(cfg, user, rec.path, rec.assetId),
  };
}

function cacheRequest(cfg, user, path, assetId) {
  return new Request(
    `${cfg.cacheOrigin}/f/${encodeURIComponent(user)}/${encodePath(path)}?v=${assetId}`,
  );
}

// 解析操作对象：默认自己，管理员可用 ?user= 指定他人。
async function targetUser(url, env, actor) {
  const wanted = url.searchParams.get("user");
  if (!wanted || wanted === actor.user) return { user: actor.user };
  if (actor.role !== "admin") return { error: "只能操作自己的文件", status: 403 };
  if (!(await getUser(env, wanted))) return { error: "没有这个用户", status: 404 };
  return { user: wanted };
}

export async function handleFilesApi(request, env, cfg, route, url, actor) {
  if (route === "me") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ user: actor.user, role: actor.role, via: actor.via });
  }

  if (route === "files") {
    if (request.method !== "GET") return methodNotAllowed();
    const t = await targetUser(url, env, actor);
    if (t.error) return json({ error: t.error }, t.status);

    const { files, dirs } = await listUser(env, t.user);
    const limits = {
      files: files.length,
      maxFiles: cfg.maxFilesPerUser,
      keep: files.filter((f) => f.keep).length,
      maxKeep: cfg.maxKeepPerUser,
    };
    if (wantsText(url)) {
      // 路径不含控制字符（见 isPathSegments），一行一项不会串行。
      const lines = [
        `${t.user}：${limits.files}/${limits.maxFiles} 个文件，长期 ${limits.keep}/${limits.maxKeep} 个`,
      ];
      for (const d of dirs) lines.push(`  dir                          ${d}`);
      for (const f of files) {
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

  if (route === "upload") {
    if (request.method !== "POST" && request.method !== "PUT") return methodNotAllowed();
    return upload(request, env, cfg, url, actor);
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

async function upload(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || url.searchParams.get("name") || "";
  if (!isPathSegments(path, cfg)) {
    return json(
      { error: "路径不合法：不能以 / 开头或结尾，不能含 . / .. 段或控制字符，长度和层数有上限" },
      400,
    );
  }
  if (!extAllowed(basename(path), cfg.allowedExt)) {
    return json({ error: `不允许的扩展名，仅接受：${cfg.allowedExt.join(", ")}` }, 415);
  }
  if (!keyFits(actor.user, path)) {
    return json({ error: "路径过长（非 ASCII 字符按编码后长度计算）" }, 414);
  }

  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) {
    return json({ error: "上传需要 Content-Length（请勿使用 chunked 请求体）" }, 411);
  }
  if (length > cfg.maxFileBytes) {
    return json(
      { error: `单文件上限 ${cfg.maxFileBytes} 字节，当前 ${length} 字节` },
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
  const assetName = `fb_${actor.user}_${randomHex(12)}`;
  const label = path.length <= 120 ? path : path.slice(-120);

  let asset;
  try {
    asset = await uploadAsset(cfg, {
      name: assetName,
      label,
      body: request.body,
      contentType,
      contentLength: length,
    });
  } catch (err) {
    // 422 多半是 release 的资产数到了 1000（GitHub 没有文档说明满了返回什么）。
    // 请求体已经读掉了，没法在这里重试；先清理一批，让客户端重新上传。
    if (err.status === 422) {
      const r = await evict(env, cfg, 10).catch(() => ({ deleted: [] }));
      console.log(JSON.stringify({ uploadFull: true, evicted: r.deleted }));
      return json(
        {
          error: r.deleted.length
            ? `GitHub release 已满，已自动清理 ${r.deleted.length} 个最旧的文件，请重新上传`
            : "GitHub release 已满（最多 1000 个资产），而且没有可以自动清理的文件",
          evicted: r.deleted.length,
        },
        507,
      );
    }
    return json({ error: err.message }, 502);
  }

  const record = {
    path,
    assetId: asset.id,
    assetName: asset.name,
    size: asset.size,
    type: asset.content_type || contentType,
    created: new Date().toISOString(),
  };
  // 覆盖上传保留长期标记。
  if (existing && existing.keep) record.keep = true;
  await putFile(env, actor.user, record);

  // 覆盖：新资产已经就位、索引已经指向新 id，旧资产可以删了。
  if (existing) {
    try {
      await deleteAsset(cfg, existing.assetId);
    } catch {
      // 旧资产删不掉只是留下一个不可达对象，不影响新文件。
    }
    if (cfg.cacheEnabled) {
      await caches.default
        .delete(cacheRequest(cfg, actor.user, path, existing.assetId))
        .catch(() => {});
    }
  }

  if (wantsText(url)) {
    return text(`${url.origin}${fileUrl(cfg, actor.user, record.path, record.assetId)}`, 201);
  }
  return json({ file: publicFile(cfg, actor.user, record) }, 201);
}

async function remove(request, env, cfg, url, actor) {
  const path = url.searchParams.get("path") || url.searchParams.get("name") || "";
  if (!isPathSegments(path, cfg)) return json({ error: "路径不合法" }, 400);

  const t = await targetUser(url, env, actor);
  if (t.error) return json({ error: t.error }, t.status);

  const rec = await getFile(env, t.user, path);
  if (!rec) return json({ error: "没有这个文件" }, 404);

  try {
    await deleteAsset(cfg, rec.assetId);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  await deleteFileRecord(env, t.user, path);

  if (cfg.cacheEnabled) {
    await caches.default.delete(cacheRequest(cfg, t.user, path, rec.assetId)).catch(() => {});
  }
  return json({ deleted: path });
}

// 长期文件不参与自动清理。数量有上限：每人 maxKeepPerUser 个，全站 maxKeepTotal 个。
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
      const total = all.filter((f) => f.keep).length;
      if (total >= cfg.maxKeepTotal) {
        return json({ error: `全站长期文件已达上限 ${cfg.maxKeepTotal} 个` }, 409);
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
