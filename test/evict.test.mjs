// 自动清理、孤儿对账、分段下载区间换算的单元测试：node test/evict.test.mjs
import assert from "node:assert/strict";
import { findOrphans, orphanDoubt, planEviction } from "../src/evict.js";
import { parseRange, partSlices } from "../src/download.js";
import { resolveConfig, MAX_PARTS } from "../src/config.js";

const cfg = { maxAssetsPerUser: 3, evictHigh: 6, evictLow: 4 };
// parts 是这个文件占几个资产（分段数）。
const f = (user, n, keep = false, parts = 1) => ({
  user,
  path: `${user}${n}`,
  assetId: `${user}${n}`,
  assets: Array.from({ length: parts }, (_, i) => `${user}${n}.${i}`),
  created: `2026-01-${String(n).padStart(2, "0")}`,
  keep,
});
const names = (xs) => xs.map((x) => x.path);

// ── planEviction ──

// 都没超：不删。
assert.deepEqual(names(planEviction([f("a", 1), f("b", 2)], cfg)), []);

// a 超出个人上限 2 个：只删 a 最旧的两个，b 的文件更旧也不动。
assert.deepEqual(
  names(planEviction([f("b", 1), f("a", 2), f("a", 3), f("a", 4), f("a", 5), f("a", 6)], cfg)),
  ["a2", "a3"],
);

// 长期文件跳过。
assert.deepEqual(names(planEviction([f("a", 1, true), f("a", 2), f("a", 3), f("a", 4)], cfg)), ["a2"]);

// 全站超过 evictHigh、每人都没超：删全站最旧的，删到 evictLow。
assert.deepEqual(
  names(planEviction([f("a", 1), f("b", 2), f("c", 3), f("a", 4), f("b", 5), f("c", 6), f("d", 7)], cfg)),
  ["a1", "b2", "c3"],
);

// 先个人后全站：a 有 4 个，先删 a1；剩 7 个仍超过 6，再删全站最旧的 3 个。
assert.deepEqual(
  names(planEviction(
    [f("a", 1), f("b", 2), f("a", 3), f("c", 4), f("a", 5), f("b", 6), f("a", 7), f("c", 8)],
    cfg,
  )),
  ["a1", "b2", "a3", "c4"],
);

// 全是长期文件：删不了。
assert.deepEqual(names(planEviction([1, 2, 3, 4, 5, 6, 7].map((n) => f(`u${n}`, n, true)), cfg)), []);

// 恰好等于 evictHigh：不删。
assert.deepEqual(names(planEviction([1, 2, 3, 4, 5, 6].map((n) => f(`u${n}`, n)), cfg)), []);

// 按名额算：a 只有 2 个文件，但大文件占 3 个名额，合计 4 个超出 1 个，删最旧的那个就够。
assert.deepEqual(names(planEviction([f("a", 1), f("a", 2, false, 3)], cfg)), ["a1"]);

// 最旧的是 3 段的大文件：删掉它一个就腾出 3 个名额，后面的不用动。
assert.deepEqual(names(planEviction([f("a", 1, false, 3), f("a", 2), f("a", 3)], cfg)), ["a1"]);

// 全站按名额：每人都没超个人上限，合计 1+1+1+2+2 = 7 > 6，删到 4 以内：
// 删 a1（剩 6）、b2（剩 5）、a3（剩 4），停。
assert.deepEqual(
  names(planEviction([f("a", 1), f("b", 2), f("a", 3), f("b", 4, false, 2), f("c", 5, false, 2)], cfg)),
  ["a1", "b2", "a3"],
);
// 最旧的是 2 段的大文件：删掉它就腾出 2 个名额。合计 2+1+1+1+1+1 = 7，删 a1 后剩 5，再删 b2 剩 4。
assert.deepEqual(
  names(planEviction([f("a", 1, false, 2), f("b", 2), f("c", 3), f("d", 4), f("e", 5), f("g", 6)], cfg)),
  ["a1", "b2"],
);

// ── findOrphans ──

const now = Date.parse("2026-01-10T12:00:00Z");
const ocfg = { orphanHours: 6 };
const asset = (id, name, hoursAgo) => ({ id, name, created: new Date(now - hoursAgo * 3600e3).toISOString() });
const files = [{ assets: [101, 102, 103] }, { assets: [200] }];

assert.deepEqual(
  findOrphans(
    [
      asset(101, "fb_a_1", 100), // 有索引
      asset(103, "fb_a_3", 100), // 分段文件的第 3 段，也有索引
      asset(300, "fb_a_x", 7), // 没索引、超过 6 小时：孤儿
      asset(301, "fb_a_y", 5), // 没索引、还不到 6 小时：可能是正在进行的分段上传
      asset(302, "manual.zip", 100), // 不是 fb_ 开头：不碰
    ],
    files,
    ocfg,
    now,
  ).map((a) => a.id),
  [300],
);

// ── orphanDoubt ──

const fb = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: `fb_a_${i}` }));
assert.equal(orphanDoubt(fb(12), fb(3)), null); // 零星几个：删
assert.equal(orphanDoubt(fb(12), fb(6)), null); // 恰好一半：删
assert.ok(orphanDoubt(fb(12), fb(7))); // 一半以上：不删
assert.ok(orphanDoubt(fb(2), fb(2))); // 本地 KV 连着只有 2 个文件的线上 release：不删
assert.ok(orphanDoubt([...fb(1), { id: 9, name: "manual.zip" }], fb(1))); // 非 fb_ 资产不计入
assert.equal(orphanDoubt(fb(5), []), null);

// ── 区间 ──

assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
assert.deepEqual(parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
assert.equal(parseRange("bytes=0-1,5-9", 1000), null); // 多区间：按整文件返回
assert.equal(parseRange("bytes=9-5", 1000), null);
assert.equal(parseRange("items=0-1", 1000), null);

// 三段 100/100/50。
const sizes = [100, 100, 50];
assert.deepEqual(partSlices(sizes, 0, 249), [
  { index: 0, from: 0, to: 99 },
  { index: 1, from: 0, to: 99 },
  { index: 2, from: 0, to: 49 },
]);
assert.deepEqual(partSlices(sizes, 150, 160), [{ index: 1, from: 50, to: 60 }]);
assert.deepEqual(partSlices(sizes, 99, 100), [
  { index: 0, from: 99, to: 99 },
  { index: 1, from: 0, to: 0 },
]);
assert.deepEqual(partSlices(sizes, 230, 249), [{ index: 2, from: 30, to: 49 }]);

// ── 配置 ──

const d = resolveConfig({});
assert.equal(d.partBytes, 95 * 1024 * 1024);
assert.equal(d.maxFileBytes, 2048 * 1024 * 1024);
assert.ok(d.maxFileBytes <= d.partBytes * MAX_PARTS);
// 回执必须比孤儿判定先过期。
assert.ok(d.receiptSeconds < d.orphanHours * 3600);
const small = resolveConfig({ ORPHAN_HOURS: "0.01", PART_BYTES: "1048576" });
assert.ok(small.receiptSeconds < small.orphanHours * 3600);
assert.equal(small.partBytes, 1024 * 1024);
assert.equal(small.maxFileBytes, MAX_PARTS * 1024 * 1024);
// 段长取整到 MiB，不超过 95 MiB。
assert.equal(resolveConfig({ PART_BYTES: "3000000" }).partBytes, 2 * 1024 * 1024);
assert.equal(resolveConfig({ PART_BYTES: String(500 * 1024 * 1024) }).partBytes, 95 * 1024 * 1024);

console.log("evict / orphans / ranges / config: all cases passed");
