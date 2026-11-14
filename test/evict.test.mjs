// planEviction 的单元测试：node test/evict.test.mjs
import assert from "node:assert/strict";
import { planEviction } from "../src/evict.js";

const cfg = { maxFilesPerUser: 3, evictHigh: 6, evictLow: 4 };
const f = (user, n, keep = false) => ({
  user,
  path: `${user}${n}`,
  assetId: `${user}${n}`,
  created: `2026-01-${String(n).padStart(2, "0")}`,
  keep,
});
const names = (xs) => xs.map((x) => x.path);

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

console.log("planEviction: all cases passed");
