// 自动清理。release 最多放 1000 个资产，filebox 又只是临时存储，
// 所以满之前就按时间删掉最旧的文件。
//
// 计数单位是「名额」，也就是 release 里的资产：普通文件占一个，
// 分段上传的大文件一段占一个。规则（数值见 config.js）：
//   1. 长期文件（keep）永远不删。
//   2. 某个用户占用的名额超过 maxAssetsPerUser，先删他自己最旧的文件，删到上限以内。
//      这样一个人批量上传或者传大文件，挤掉的是他自己的旧文件，不会冲掉别人的。
//   3. 全站名额仍然超过 evictHigh，再删全站最旧的，删到 evictLow 以内。
//
// 由定时任务每小时跑一次；上传撞上 GitHub 的 422（多半是 release 满了）时
// 也会跑一次。每次删除的资产数有上限，剩下的留给下一次。
//
// 定时任务还会对账：release 里有、索引里没有的 fb_ 资产（孤儿），创建超过
// orphanHours 小时就删掉。孤儿来自中断的分段上传、写索引失败的上传，
// 以及删除时没删干净的资产。

import { MAX_PARTS } from "./config.js";
import { deleteAsset, deleteAssets, listAssets } from "./github.js";
import { assetIdsOf, deleteFileRecord, getFile, listAllFiles } from "./store.js";

const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));
const weight = (f) => (f.assets ? f.assets.length : 1);

// 纯函数：给出按删除先后排好的待删列表，方便单独测试。
export function planEviction(files, cfg) {
  const doomed = new Set();
  const order = [];

  const byUser = new Map();
  for (const f of files) {
    if (!byUser.has(f.user)) byUser.set(f.user, []);
    byUser.get(f.user).push(f);
  }
  for (const list of byUser.values()) {
    let over = list.reduce((n, f) => n + weight(f), 0) - cfg.maxAssetsPerUser;
    for (const f of list.filter((x) => !x.keep).sort(byCreated)) {
      if (over <= 0) break;
      doomed.add(f);
      order.push(f);
      over -= weight(f);
    }
  }

  let remaining = files.reduce((n, f) => n + (doomed.has(f) ? 0 : weight(f)), 0);
  if (remaining > cfg.evictHigh) {
    const pool = files.filter((f) => !f.keep && !doomed.has(f)).sort(byCreated);
    for (const f of pool) {
      if (remaining <= cfg.evictLow) break;
      order.push(f);
      remaining -= weight(f);
    }
  }
  return order;
}

// 删除一个文件：先删第一个资产，成功了再删索引，最后删其余的段。
// 第一个资产删不掉（GitHub 出错）就抛出，什么都没变；后面的段删不掉，
// 它们成为孤儿，由对账任务收拾。返回实际发出的删除请求数。
export async function purgeFile(env, cfg, user, rec) {
  const ids = assetIdsOf(rec);
  await deleteAsset(cfg, ids[0]);
  await deleteFileRecord(env, user, rec.path);
  const left = await deleteAssets(cfg, ids.slice(1));
  return ids.length - (left.length ? left.length - 1 : 0);
}

// 真正执行。limit 是本次最多发出的删除请求数（一个资产一个）。
// 返回 { total, assets, planned, deleted: [{ user, path }], used }。
export async function evict(env, cfg, limit = cfg.evictBatch) {
  const files = await listAllFiles(env);
  const plan = planEviction(files, cfg);
  const deleted = [];
  let used = 0;

  for (const f of plan) {
    // 一个大文件最多 MAX_PARTS 段，比 limit 大时至少也要删得掉。
    if (used > 0 && used + weight(f) > Math.max(limit, MAX_PARTS)) break;
    if (used >= limit) break;
    // 列表是 list 时的快照。删之前重读一次：期间如果被覆盖上传（资产 id 变了）
    // 或者刚被设为长期，就跳过，免得删掉新文件。
    const rec = await getFile(env, f.user, f.path);
    if (!rec || rec.keep || String(rec.assetId) !== String(f.assetId)) continue;
    try {
      used += await purgeFile(env, cfg, f.user, rec);
    } catch (err) {
      // GitHub 出错就停下，别把剩下的子请求额度也耗在失败上。
      console.log(JSON.stringify({ evictError: err.message, user: f.user, path: f.path }));
      used += 1;
      break;
    }
    // 边缘缓存不用删：下载先查 KV，记录没了就 404，缓存里的旧内容不会再被读到。
    deleted.push({ user: f.user, path: f.path });
  }

  const assets = files.reduce((n, f) => n + weight(f), 0);
  return { total: files.length, assets, planned: plan.length, deleted, used };
}

// 纯函数：从 release 的资产列表里挑出孤儿。只看 fb_ 开头的资产，
// 别人手工放进 release 的东西不碰。
export function findOrphans(assets, files, cfg, now = Date.now()) {
  const known = new Set();
  for (const f of files) for (const id of f.assets) known.add(String(id));
  const cutoff = now - cfg.orphanHours * 3600 * 1000;
  return assets.filter(
    (a) =>
      String(a.name).startsWith("fb_") &&
      !known.has(String(a.id)) &&
      Date.parse(a.created) < cutoff,
  );
}

// 纯函数：孤儿多得不正常时返回原因，调用方不删。一半以上的 fb_ 资产都像孤儿，
// 多半是 KV 和 release 对不上（比如本地 dev 的 KV 连着线上 release），而正常情况下
// 孤儿只是零星几个。代价是几乎空的 release 里的孤儿要等别的文件多起来才会被删。
export function orphanDoubt(assets, orphans) {
  const ours = assets.filter((a) => String(a.name).startsWith("fb_")).length;
  if (orphans.length && orphans.length * 2 > ours) {
    return `${ours} 个资产里有 ${orphans.length} 个像孤儿，不像正常情况`;
  }
  return null;
}

// 对账。budget 是还能用的外部子请求数：查 release 1 个，列资产每页 1 个，删一个资产 1 个。
export async function sweepOrphans(env, cfg, budget) {
  if (budget < 4) return { skipped: "子请求额度不够" };
  const files = await listAllFiles(env);
  // 有键没能还原成记录（解码失败或者读的时候刚被删）时不对账：
  // 那条记录引用的资产会被误判成孤儿。
  if (files.dropped) return { skipped: `有 ${files.dropped} 条索引没读出来` };

  const { assets, pages } = await listAssets(cfg, Math.min(10, budget - 2));
  const orphans = findOrphans(assets, files, cfg);
  const doubt = orphanDoubt(assets, orphans);
  if (doubt) return { skipped: doubt, orphans: orphans.length };

  const room = Math.max(0, budget - pages - 1);
  const ids = orphans.slice(0, room).map((a) => a.id);
  const left = await deleteAssets(cfg, ids);
  return {
    assets: assets.length,
    orphans: orphans.length,
    deleted: ids.length - left.length,
  };
}
