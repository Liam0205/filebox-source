// filebox —— 以 GitHub Releases 为后端、Cloudflare Worker 为前端的文件箱。
//
//   /                         说明页
//   /admin                    管理页面（账号登录后管理文件、token、用户）
//   /f/<用户>/<路径>           公开下载，不需要登录
//   /api/*                    文件管理 API，需要 token 或会话
//   /filebox                  命令行客户端（scripts/filebox，填好站点地址）
//   /manifest.webmanifest     「添加到主屏幕」用的 manifest，图标在 /icons/
//
// 字节存在私有仓库的 release 资产里，路径和归属存在 KV。选择代理而不是
// 302：私有资产的下载地址是短时效签名 URL，且域名在部分网络下不可用。

import { resolveConfig } from "./config.js";
import { currentActor, sameOrigin } from "./access.js";
import { handleFilesApi } from "./files.js";
import { serveFile } from "./download.js";
import { handleAdmin } from "./admin.js";
import { evict, sweepOrphans } from "./evict.js";
import { esc, html, json, notFound, text } from "./http.js";
import { sha256Hex } from "./auth.js";
import { appIcon, appManifest } from "./app.js";
// wrangler.jsonc 的 rules 把这个文件按纯文本打包进来。
import CLI_SCRIPT from "../scripts/filebox";

export default {
  async fetch(request, env, ctx) {
    const cfg = resolveConfig(env);
    const url = new URL(request.url);

    // 明文 http 上口令和 token 都会裸奔。读请求跳到 https；写请求直接拒绝，
    // 因为跳转时请求体已经明文发出去了，拒绝才能让客户端发现配置错了。
    if (cfg.enforceHttps && url.protocol === "http:") {
      if (request.method === "GET" || request.method === "HEAD") {
        url.protocol = "https:";
        return Response.redirect(url.toString(), 301);
      }
      return text("请使用 HTTPS", 403);
    }

    const res = await dispatch(request, env, ctx, cfg, url);
    if (!cfg.enforceHttps) return res;
    const out = new Response(res.body, res);
    out.headers.set("strict-transport-security", "max-age=31536000");
    return out;
  },

  // wrangler.jsonc 的 triggers.crons 每小时触发一次，规则见 evict.js。
  // 先清理，剩下的外部子请求额度（免费版每次 50 个）留给孤儿对账。
  async scheduled(controller, env, ctx) {
    const cfg = resolveConfig(env);
    if (!env.USERS || !cfg.githubToken || !cfg.repo || !cfg.releaseTag) return;
    const r = await evict(env, cfg);
    let sweep = { skipped: "SWEEP_ORPHANS 没打开" };
    if (cfg.sweepOrphans) {
      sweep = await sweepOrphans(env, cfg, 48 - r.used, r.files).catch((err) => ({ error: err.message }));
    }
    console.log(JSON.stringify({
      cron: controller.cron,
      total: r.total,
      assets: r.assets,
      planned: r.planned,
      evicted: r.deleted,
      sweep,
    }));
  },
};

async function dispatch(request, env, ctx, cfg, url) {
  const path = stripBase(cfg, url.pathname);
  if (path === null) return notFound(cfg);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, range",
        "access-control-max-age": "86400",
      },
    });
  }

  if (path === "/healthz") {
    return json({ ok: true });
  }

  if (path === "/") return landing(cfg, url);

  if (path === "/filebox") return cliScript(request, cfg, url);

  if (path === "/manifest.webmanifest") return appManifest(cfg);
  if (path.startsWith("/icons/")) {
    const m = /^\/icons\/([0-9]+)\.png$/.exec(path);
    const res = m ? appIcon(m[1]) : null;
    if (res) return res;
    return notFound(cfg);
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    return handleAdmin(request, env, cfg, path);
  }

  if (path === "/api" || path.startsWith("/api/")) {
    if (!env.USERS) return text("服务未配置：缺少 USERS 绑定", 500);
    const route = path.slice("/api/".length);
    const actor = await currentActor(request, env, cfg);
    if (!actor) return json({ error: "需要登录或 token" }, 401);
    if (actor.error) return json({ error: actor.error }, actor.status);
    if (actor.via === "session" && !sameOrigin(request, url)) {
      return json({ error: "跨站请求被拒绝" }, 403);
    }
    return handleFilesApi(request, env, cfg, route, url, actor);
  }

  if (path === "/f" || path.startsWith("/f/")) {
    const parsed = parseFileRoute(path);
    if (!parsed) return text("下载地址形如 /f/<用户>/<路径>", 400);
    return serveFile(request, env, cfg, ctx, parsed.user, parsed.path, url);
  }

  return notFound(cfg);
}

// 下发命令行脚本，顺手把 DEFAULT_URL 填成当前站点，VERSION 填成脚本内容的摘要
// （filebox update 靠它报告从哪个版本升到哪个版本）。站点地址来自请求，
// 会被原样写进一段 shell 脚本，所以只接受最朴素的形式，不合格就留空，
// 避免借 Host 头往脚本里注入代码。
const SITE_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*$/;
const DEFAULT_URL_LINE = 'DEFAULT_URL=""';
const VERSION_LINE = 'VERSION="dev"';
let scriptVersion = null;

async function cliScript(request, cfg, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method Not Allowed", 405, { allow: "GET, HEAD" });
  }
  if (!scriptVersion) scriptVersion = (await sha256Hex(CLI_SCRIPT)).slice(0, 10);
  const site = `${url.origin}${cfg.basePath}`;
  let body = CLI_SCRIPT.replace(VERSION_LINE, `VERSION="${scriptVersion}"`);
  if (SITE_RE.test(site)) body = body.replace(DEFAULT_URL_LINE, `DEFAULT_URL="${site}"`);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'inline; filename="filebox"',
      // filebox update 要拿到刚部署的版本，所以缓存时间短。
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function stripBase(cfg, pathname) {
  let p = pathname;
  if (cfg.basePath) {
    if (p === cfg.basePath) p = "/";
    else if (p.startsWith(`${cfg.basePath}/`)) p = p.slice(cfg.basePath.length);
    else return null;
  }
  return p.replace(/\/+$/, "") || "/";
}

// /f/<user>/<path...>，逐段解码；解码后仍含 / 的段视为非法。
function parseFileRoute(path) {
  const rest = path.slice("/f/".length);
  const i = rest.indexOf("/");
  if (i < 0) return null;
  let user;
  try {
    user = decodeURIComponent(rest.slice(0, i));
  } catch {
    return null;
  }
  const segs = [];
  for (const raw of rest.slice(i + 1).split("/")) {
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg.includes("/")) return null;
    segs.push(seg);
  }
  return { user, path: segs.join("/") };
}

function landing(cfg, url) {
  const base = cfg.basePath;
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(cfg.siteName)}</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1f2328;--muted:#606a75;--line:#e3e5e8}
 @media(prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa4b0;--line:#2c3138}}
 body{margin:0;padding:56px 20px;background:var(--bg);color:var(--fg);
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  display:flex;justify-content:center}
 main{width:100%;max-width:640px}
 h1{font-size:24px;margin:0 0 6px}
 p{color:var(--muted);font-size:14px}
 a{color:inherit}
 code{font-family:ui-monospace,Menlo,monospace;font-size:13px;
  background:#0000000d;padding:2px 6px;border-radius:4px}
 @media(prefers-color-scheme:dark){code{background:#ffffff14}}
 pre{background:#0000000d;padding:14px;border-radius:8px;overflow:auto;font-size:13px}
 @media(prefers-color-scheme:dark){pre{background:#ffffff14}}
</style></head><body><main>
<h1>${esc(cfg.siteName)}</h1>
<p>私有存储，公开读取。上传需要账号或 API token。</p>
<p><a href="${esc(base)}/admin"><code>${esc(base)}/admin</code></a> · 登录后可以管理文件和 token。</p>
<p>命令行工具：<a href="${esc(base)}/filebox"><code>${esc(base)}/filebox</code></a>（Bash 脚本，macOS 和 Linux 都能用）。</p>
<pre>curl -fsSL ${esc(url.origin)}${esc(base)}/filebox -o filebox &amp;&amp; chmod +x filebox
export FILEBOX_TOKEN=fb_…
./filebox whoami
./filebox put photo.jpg</pre>
</main></body></html>`;
  return html(body);
}
