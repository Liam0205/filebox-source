#!/usr/bin/env node
// 引导第一个管理员（或直接补一个账号）。
//
//   FILEBOX_PASSWORD='至少 8 位' node scripts/setup.mjs alice --role admin --remote
//
// 口令只从环境变量或 stdin 读，不落 shell 历史。默认写本地 dev 的 KV，
// 加 --remote 写线上命名空间。
//
// 生成的口令记录必须和 src/auth.js 的算法一致：PBKDF2-SHA256、
// 16 字节 hex 盐、32 字节输出、base64url。

import { spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function usage() {
  console.error(
    "用法: FILEBOX_PASSWORD=... node scripts/setup.mjs <用户名> [--role admin|user] [--remote] [--iterations N]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let name = "";
let role = "user";
let remote = false;
let iterations = 100000;

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--role") role = args[++i] === "admin" ? "admin" : "user";
  else if (a === "--remote") remote = true;
  else if (a === "--iterations") iterations = Number(args[++i]);
  else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage();
  else if (!name) name = a;
  else usage();
}

if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) {
  console.error("用户名只能包含字母、数字、下划线、连字符，长度 2–32");
  process.exit(1);
}

let password = process.env.FILEBOX_PASSWORD || "";
if (!password) {
  try {
    password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  } catch {
    password = "";
  }
}
if (password.length < 8) {
  console.error("口令至少 8 位（用 FILEBOX_PASSWORD 或 stdin 传入）");
  process.exit(1);
}

if (!Number.isInteger(iterations) || iterations < 10000) {
  console.error("--iterations 必须是 >= 10000 的整数");
  process.exit(1);
}

// 命名空间 id 默认从 wrangler.jsonc 的 USERS 绑定读取。
function namespaceId() {
  if (process.env.KV_NAMESPACE_ID) return process.env.KV_NAMESPACE_ID;
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const m = /"binding"\s*:\s*"USERS"[\s\S]{0,200}?"id"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error("wrangler.jsonc 里找不到 USERS 绑定的 id");
  return m[1];
}

const salt = randomBytes(16).toString("hex");
const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString(
  "base64url",
);

const record = {
  name,
  salt,
  hash,
  iterations,
  role,
  created: new Date().toISOString(),
  disabled: false,
};

const ns = namespaceId();
const cmd = [
  "-y",
  "wrangler@4.161.0",
  "kv",
  "key",
  "put",
  `user:${name}`,
  JSON.stringify(record),
  "--namespace-id",
  ns,
];
if (remote) cmd.push("--remote");

console.log(`写入 ${remote ? "线上" : "本地"} KV ${ns}：user:${name}（${role}）`);
const res = spawnSync("npx", cmd, { stdio: "inherit", cwd: root });
process.exit(res.status ?? 1);
