// 所有可调项集中在这里，线上值来自 wrangler.jsonc 的 vars 和 secrets。

function str(value, fallback) {
  const s = value == null ? "" : String(value).trim();
  return s === "" ? fallback : s;
}

function num(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function pathPrefix(value) {
  const s = str(value, "");
  if (s === "" || s === "/") return "";
  const t = s.replace(/\/+$/, "");
  return t === "" ? "" : t.startsWith("/") ? t : `/${t}`;
}

const MIB = 1024 * 1024;
// 一个文件最多切成多少段。下载时每段要 2 个外部子请求（查资产、跟随签名跳转），
// 免费版每次调用最多 50 个，留几个给缓存和查 release。
export const MAX_PARTS = 22;

// 段长取整到 MiB（命令行用 dd 按 MiB 切），1 MiB 到 95 MiB 之间。
function partSize(value) {
  const n = Math.floor(num(value, 95 * MIB) / MIB) * MIB;
  return Math.min(95 * MIB, Math.max(MIB, n));
}

// 孤儿资产的判定时长（小时）和分段回执的有效期（秒）。回执必须比判定时长先过期，
// 否则清理任务可能删掉一段、随后才有人拿着回执提交，留下一个缺段的文件。
// 测试时可以把 ORPHAN_HOURS 设成很小的小数。
function orphanTimes(value) {
  const hours = Math.max(0.001, num(value, 6));
  const receiptHours = hours >= 2 ? hours - 1 : hours / 2;
  return { orphanHours: hours, receiptSeconds: Math.floor(receiptHours * 3600) };
}

export function resolveConfig(env = {}) {
  const partBytes = partSize(env.PART_BYTES);
  return {
    // ── 部署位置 ────────────────────────────────────────────
    // Worker 挂载的路径前缀，与 wrangler.jsonc 的路由保持一致。
    basePath: pathPrefix(env.BASE_PATH),
    // 把 http 请求跳到 https，并加 HSTS 头。wrangler dev 会把请求地址改写成
    // 路由里的 http://主机名，本地开发要在 .dev.vars 里设成 false。
    enforceHttps: bool(env.ENFORCE_HTTPS, true),

    // ── 存储 ────────────────────────────────────────────────
    // 仓库，owner/repo。必须是私有仓库。
    repo: str(env.GITHUB_REPO, ""),
    // 存放资产的 release tag。所有文件都挂在这个 release 下。
    releaseTag: str(env.RELEASE_TAG, ""),
    // 有 Releases 读写权限的 token。用 wrangler secret put 设置。
    githubToken: str(env.GITHUB_TOKEN, ""),
    userAgent: str(env.USER_AGENT, "filebox"),
    apiTimeoutMs: num(env.API_TIMEOUT_MS, 20000),

    // ── 账号 ────────────────────────────────────────────────
    // 会话 cookie 的 HMAC 密钥。必须设置，否则管理页不可用。
    sessionSecret: str(env.SESSION_SECRET, ""),
    // PBKDF2 迭代次数。免费版 Worker 每个请求只有 10ms CPU，
    // 这个值需要按实际运行时表现调整（见 README）。
    passwordIterations: Math.max(10000, num(env.PASSWORD_ITERATIONS, 100000)),

    // ── 文件 ────────────────────────────────────────────────
    // 免费版 Worker 的入口请求体上限是 100 MB，所以一次请求最多传一段，
    // 默认 95 MiB；更大的文件由客户端切段上传，下载时 Worker 按顺序拼接。
    partBytes,
    // 单文件上限，默认 2 GiB，同时不能超过 MAX_PARTS 段。
    maxFileBytes: Math.min(num(env.MAX_FILE_BYTES, 2048 * MIB), partBytes * MAX_PARTS),
    // 虚拟路径总长度与段数上限。
    maxPathLength: num(env.MAX_PATH_LENGTH, 300),
    maxPathSegments: num(env.MAX_PATH_SEGMENTS, 10),
    // 只允许这些扩展名，空表示不限。形如 "png,jpg,mp4"。
    allowedExt: str(env.ALLOWED_EXT, "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean),

    // ── 自动清理（见 evict.js）────────────────────────────────
    // filebox 是临时存储，release 最多放 1000 个资产。长期文件永远不删。
    // 下面的「名额」就是 release 里的资产：一段占一个，大文件占好几个。
    // 每个用户最多占用的名额（长期文件也算在内），超出就删他自己最旧的文件。
    maxAssetsPerUser: num(env.MAX_ASSETS_PER_USER, 300),
    // 每个用户最多标记多少个长期文件（按文件数）；全站长期文件最多占多少名额。
    // 全站按名额算，是为了防止长期的大文件把 release 占满，清理也腾不出地方。
    maxKeepPerUser: num(env.MAX_KEEP_PER_USER, 20),
    maxKeepTotal: num(env.MAX_KEEP_TOTAL, 200),
    // 全站名额超过 evictHigh 时，删最旧的非长期文件，直到 evictLow。
    evictHigh: num(env.EVICT_HIGH, 950),
    evictLow: num(env.EVICT_LOW, 900),
    // 每次最多删多少个资产。免费版每次调用最多 50 个外部子请求，删一个资产花一个。
    evictBatch: num(env.EVICT_BATCH, 40),
    // 孤儿资产：release 里有、KV 索引里没有的资产，来自中断的分段上传、
    // 写索引失败的上传、删不干净的账号。创建超过 orphanHours 小时才删，给分段上传留出时间。
    ...orphanTimes(env.ORPHAN_HOURS),
    // 定时任务是否删孤儿资产。本地 wrangler dev 的 KV 和线上不是同一份，却连着同一个
    // release，打开它会把线上文件当成孤儿。所以默认关；线上配置打开，本地 .dev.vars 关掉
    // （.dev.vars 的值会盖过 wrangler.jsonc 的 vars）。evict.js 另外有保护：一大半资产
    // 都像孤儿时不删。
    sweepOrphans: bool(env.SWEEP_ORPHANS, false),

    // ── 缓存 ────────────────────────────────────────────────
    cacheEnabled: bool(env.CACHE_ENABLED, true),
    cacheOrigin: str(env.CACHE_ORIGIN, "https://filebox.internal"),
    // 带版本号的下载 URL（?v=<assetId>）可以缓存这么久；
    // 不带版本号的地址内容可能被覆盖，只给一个短 TTL。
    assetTtl: num(env.ASSET_TTL, 604800),
    versionedTtl: num(env.VERSIONED_TTL, 31536000),

    // ── 界面 ────────────────────────────────────────────────
    siteName: str(env.SITE_NAME, "filebox"),
  };
}
