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

export function resolveConfig(env = {}) {
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
    // 单文件上限，默认 95 MiB（免费版入口请求体上限 100 MB）。
    maxFileBytes: num(env.MAX_FILE_BYTES, 95 * 1024 * 1024),
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
    // 每个用户最多保存的文件数（长期文件也算在内），超出就删他自己最旧的。
    maxFilesPerUser: num(env.MAX_FILES_PER_USER, 300),
    // 每个用户、全站最多标记多少个长期文件。长期文件一直占着名额，所以要封顶。
    maxKeepPerUser: num(env.MAX_KEEP_PER_USER, 20),
    maxKeepTotal: num(env.MAX_KEEP_TOTAL, 200),
    // 全站文件数超过 evictHigh 时，删最旧的非长期文件，直到 evictLow。
    evictHigh: num(env.EVICT_HIGH, 950),
    evictLow: num(env.EVICT_LOW, 900),
    // 每次最多删多少个。免费版每次调用最多 50 个外部子请求，删一个文件花一个。
    evictBatch: num(env.EVICT_BATCH, 40),

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
