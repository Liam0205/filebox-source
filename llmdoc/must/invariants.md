# 不变量

下面这些不变量在改代码和配置时必须守住。每条都写了守住它的代码位置，以及破坏它的后果。

## 1. 下载先查 KV 索引，再查边缘缓存

在 `src/download.js` 的 `serveFile` 里，`getFile` 排在 `cache.match` 之前。

反过来的话，删除的文件会继续从 Cache API 里被端出去，而且 Cache API 的 `delete` 只清当前节点，别的节点清不掉。

## 2. 缓存键带 assetId

缓存键是 `.../f/<用户>/<路径>?v=<assetId>`。覆盖上传换了资产 id，缓存键自然跟着换，不需要跨节点失效。

缓存键要是只含路径，覆盖上传后各节点会继续返回旧内容，直到 TTL 过期。

## 3. 主动内容一律附件下载

`INLINE_RE` 之外的类型一律加 `Content-Disposition: attachment`，凡是浏览器可能执行脚本的类型（比如 HTML 和 SVG）都落在这一类。所有下载响应都带 `nosniff` 和 `CSP: default-src 'none'; sandbox`。

下载与管理页同源。如果让用户上传的 HTML 内联渲染，它就能借打开它的那个登录用户的 cookie 调 `/api/*`。`Content-Type` 是上传者自己声明的，不可信；内联白名单只能收窄，不能放宽。

## 4. GitHub 凭据不跨域

`src/github.js` 的 `assetDownload` 用 `redirect: "manual"`，跟随签名 URL 时只带 `user-agent` 和 `range`。

`redirect: "follow"` 会把 `Authorization` 一起发给 `release-assets.githubusercontent.com`。

## 5. 身份每次回查 KV

会话 cookie 和 token 只用来定位用户。角色和停用状态以 KV 里的用户记录为准，账号版本 `ver` 也是（见 `src/access.js` 的 `currentActor`，以及 `src/admin.js` 开头的会话校验）。

如果只信 cookie 里的角色，那么在 cookie 到期前的 7 天里，降级和停用都不会生效，改了口令旧会话也照样能用。

## 6. KV 键长度在上传前检查

`keyFits`（`src/store.js`）必须在 `uploadAsset` 之前调用。KV 键上限 512 字节，中文路径编码后每字 9 字节。

如果先上传再写索引失败，GitHub 上会留下一个没有索引的资产，通过 filebox 的接口既看不到也删不掉。

## 7. 写操作校验同源

带会话 cookie 的 POST/PUT/DELETE 要过 `sameOrigin`，登录也一样（防止 login CSRF）。token 请求不靠 cookie，不受这条限制。

`SameSite=Strict` 已经挡住了绝大部分跨站情况，`Origin` 校验作为第二道防线保留。

## 8. JSON 请求体有上限

`readJson`（`src/http.js`）读到超过 16 KiB 就返回 null。上传走流式，不经过 `readJson`。

没有这个上限，一个超大的登录请求就能把 Worker 的 128 MB 内存撑爆。

## 9. 凭据只走 Header

token 只从 `Authorization: Bearer` 读，不接受查询串。查询串会进日志、Referer 和浏览器历史。

## 10. 不开放注册、不自动提权

代码里没有「第一个登录的人成为管理员」之类的引导。KV 不是强一致的，这种引导会有竞态。第一个管理员只能用 `scripts/setup.mjs` 建。

## 11. Worker 只能从自有域名访问

`wrangler.jsonc` 里 `workers_dev` 和 `preview_urls` 都是 `false`。

登录限流是 zone 上的速率限制规则，只对经过这个 zone 的请求生效。打开 workers.dev 或预览地址，爆破请求就能绕开限流直接打到 `/admin/api/login`。

## 12. 下发脚本前校验站点地址

`src/worker.js` 的 `cliScript` 把 `url.origin + BASE_PATH` 写进脚本的 `DEFAULT_URL=""` 那一行，写之前要过 `SITE_RE`，不合格就不填。

`new URL()` 会接受 `x.com$(id)`、``a`b`.com`` 这样的主机名。不校验的话，能控制 Host 的人就能往用户下载后要执行的脚本里注入命令。`SITE_RE` 只能收窄，不能放宽到允许 `$`、反引号、引号、空白。

## 13. 只走 HTTPS

`ENFORCE_HTTPS` 线上必须是开的（默认就是开的）。http 的 GET/HEAD 跳到 https，其他方法直接 403。

写请求不能也跳转：客户端发来跳转前的那个请求时，口令或 token 已经明文发出去了。直接拒绝，客户端才会报错，用户也才会发现地址写错了。只有本地开发可以在 `.dev.vars` 里关掉这个开关。

## 14. 自动清理不删长期文件，删前重读记录

`src/evict.js` 的 `planEviction` 跳过 `keep` 的文件；`evict` 删除前用 `getFile` 重读记录，`keep` 为真或者 `assetId` 和 list 时不一致就跳过。

用户把文件设为长期，就是在要求它不被自动删除，删了就是丢数据。不重读的话，list 之后刚被覆盖上传的文件，会连新资产一起被删掉。

## 15. 分段回执比孤儿判定先过期

`src/config.js` 的 `orphanTimes` 让回执有效期（`receiptSeconds`）总是小于孤儿判定时长（`orphanHours`），单元测试里有断言。

回执还有效、对应的段却已经被当成孤儿删掉的话，有人提交这组回执，索引里就会有一个缺段的文件，下载到一半中断。调 `ORPHAN_HOURS` 时也要大于一次分段上传实际要花的时间，否则上传会因为回执过期而失败。

## 16. 本地开发不打开孤儿对账

`.dev.vars` 里 `SWEEP_ORPHANS="false"`，它会盖过 `wrangler.jsonc` 的 vars。线上配置里这一项是 `true`，源码目录里的 `wrangler.jsonc` 又是指向线上配置的软链接。

本地 KV 和线上 KV 是两份，GitHub release 却是同一个。本地跑对账，线上文件在本地 KV 里都查不到，全会被当成孤儿删掉。`orphanDoubt` 只是第二道保险，线上 release 里文件很少时它挡不住。
