// 自动清理。release 最多放 1000 个资产，filebox 又只是临时存储，
// 所以满之前就按时间删掉最旧的文件。
//
// 规则（数值见 config.js）：
//   1. 长期文件（keep）永远不删。
//   2. 某个用户的文件数超过 maxFilesPerUser，先删他自己最旧的，删到上限。
//      这样一个人批量上传，挤掉的是他自己的旧文件，不会冲掉别人的。
//   3. 全站文件数仍然超过 evictHigh，再删全站最旧的，删到 evictLow。
//
// 由定时任务每小时跑一次；上传撞上 GitHub 的 422（多半是 release 满了）时
// 也会跑一次。每次最多删 evictBatch 个，剩下的留给下一次。

import { deleteAsset } from "./github.js";
import { deleteFileRecord, getFile, listAllFiles } from "./store.js";

const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));

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
    const over = list.length - cfg.maxFilesPerUser;
    if (over <= 0) continue;
    for (const f of list.filter((x) => !x.keep).sort(byCreated).slice(0, over)) {
      doomed.add(f);
      order.push(f);
    }
  }

  const remaining = files.length - doomed.size;
  if (remaining > cfg.evictHigh) {
    const need = remaining - cfg.evictLow;
    const pool = files.filter((f) => !f.keep && !doomed.has(f)).sort(byCreated);
    for (const f of pool.slice(0, need)) order.push(f);
  }
  return order;
}

// 真正执行。返回 { total, planned, deleted: [{ user, path }] }。
export async function evict(env, cfg, limit = cfg.evictBatch) {
  const files = await listAllFiles(env);
  const plan = planEviction(files, cfg);
  const deleted = [];

  for (const f of plan.slice(0, limit)) {
    // 列表是 list 时的快照。删之前重读一次：期间如果被覆盖上传（资产 id 变了）
    // 或者刚被设为长期，就跳过，免得删掉新文件。
    const rec = await getFile(env, f.user, f.path);
    if (!rec || rec.keep || String(rec.assetId) !== String(f.assetId)) continue;
    try {
      await deleteAsset(cfg, rec.assetId);
    } catch (err) {
      // GitHub 出错就停下，别把剩下的子请求额度也耗在失败上。
      console.log(JSON.stringify({ evictError: err.message, user: f.user, path: f.path }));
      break;
    }
    await deleteFileRecord(env, f.user, f.path);
    // 边缘缓存不用删：下载先查 KV，记录没了就 404，缓存里的旧内容不会再被读到。
    deleted.push({ user: f.user, path: f.path });
  }

  return { total: files.length, planned: plan.length, deleted };
}
