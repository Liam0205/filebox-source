# filebox

以 GitHub Releases 为后端、Cloudflare Worker 为前端的文件箱：账号登录后可以上传、建目录、管理文件，生成 API token 给脚本用；下载不需要任何校验。

## 它是怎么工作的

```
浏览器 ─┐
        ├─ Cloudflare Worker ── KV（用户、token、文件索引）
脚本 ───┘                      └─ GitHub 私有仓库的 release 资产（文件字节）
```

- **字节**存在一个私有仓库的 release 里。一般的文件对应一个资产；超过 95 MiB 的文件切成几段，每段一个资产，下载时 Worker 按顺序拼回去。
- **路径与归属**存在 Workers KV：`user:<名>`、`token:<摘要>`、`file:<用户>:<路径>`、`dir:<用户>:<路径>`。
- **下载**走 Worker 代理，不 302 到 GitHub：私有资产的下载地址是约一小时过期的签名 URL，域名在部分网络下也不稳定。

分层的直接原因：GitHub 会改写资产名里的斜杠、中文和空格（`dir/a.txt` 变成 `dir.a.txt`），所以路径不能放在资产名上。资产名用不透明 id（`fb_<用户>_<随机>`），可读路径放在资产的 `label` 字段和 KV 索引里——`label` 原样保留中文和 `/`，需要时可以据此重建索引。

## 功能

- `/admin` 管理页：账号口令登录、文件管理与上传、token 生成/吊销、用户管理（仅管理员）。
- 文件管理：任意深的虚拟目录、拖拽上传、下载、复制链接、重命名和移动文件、删除文件、新建/删除空目录。
- 每个用户只能看到和操作自己名下的文件；管理员可以代管。
- 下载公开、无需登录。上传需要账号会话或 `Authorization: Bearer <token>`。
- 单文件最大 2 GiB。超过 95 MiB 的文件由命令行和网页自动分段上传，下载地址仍然只有一个，支持 Range。
- 命令行：`filebox`，一个 Bash 脚本，站点在 `/filebox` 下发。`filebox whoami` 检查 token 配得对不对，`filebox update` 把脚本自己升级到站点上的版本。
- 临时存储，会自动清理。计数单位是「名额」，也就是 release 里的资产：普通文件占 1 个，大文件每段占 1 个。每个用户最多占 300 个名额，全站超过 950 个时删到 900 个，先删最旧的。想保留的文件可以设为长期，每人最多 20 个，全站长期文件最多占 200 个名额。见下面的「自动清理」。

## 免费额度的真实边界

这些数字是设计的硬约束，不是保守估计。

| 资源 | 免费额度 | 对应到本项目的含义 |
| --- | --- | --- |
| Worker 请求 | 100,000 次/天 | 下载、页面、API 合计 |
| Worker 入口请求体 | 100 MB | 一次请求最多传一段，段长默认 95 MiB（`PART_BYTES`） |
| Worker 外部子请求 | 每次调用 50 个 | 下载大文件时每段花 2 个，所以一个文件最多 22 段 |
| KV 读 | 100,000 次/天 | 每次下载 1 次读；列文件读 metadata，不逐条读 |
| KV 写 | 1,000 次/天 | 每次上传约 1 次 |
| KV 删 | 1,000 次/天 | 每次删除约 1 次 |
| KV list | 1,000 次/天 | 每次列目录 2 次；`/api/files` 每次调用都会 list；定时任务每小时 1 次（自动清理和孤儿对账共用） |
| KV 存储 | 1 GB | 索引很小，主要限制在 GitHub 侧 |
| GitHub release 资产数 | 1,000 个 | 所有用户合计共用一个 release，自动清理把它控制在 950 以内 |
| GitHub 单资产 | < 2 GiB | 一段一个资产，用不到这么大；单文件上限 2 GiB 是本项目自己定的（`MAX_FILE_BYTES`） |

**超额不会扣费**：免费计划下超出额度时对应操作直接报错。这也是这个方案不用 R2 的原因——R2 超量会计费。

由此推出的使用画像：几百个文件、每天几百次列目录、上千次下载，完全够用；把它当大流量图床或几百 GB 网盘会先撞上 KV list 和 GitHub 资产数上限。

## 自动清理

filebox 是临时存储。release 最多放 1000 个资产，所以 Worker 每小时跑一次定时任务（`src/evict.js`），按名额删文件。一个名额就是 release 里的一个资产，分段上传的大文件有几段就占几个名额。删除顺序如下：

1. 长期文件永远不删。
2. 某个用户占的名额超过 300 个（长期文件也算在内），先删他自己最旧的文件，删到 300 个以内。一个人批量上传或者传大文件，挤掉的是他自己的旧文件。
3. 全站名额还超过 950 个，再删全站最旧的文件，删到 900 个以内。

每次最多删 40 个资产，剩下的留给下一个小时。免费计划每次调用最多发 50 个外部子请求，删一个资产要调一次 GitHub。两次定时任务之间如果 release 被传满，上传会返回 507：服务端当场清理一批，命令行和网页会自动重传一次。

设为长期：网页文件列表里的「设为长期」，或者 `filebox keep <路径>`。每个用户最多 20 个文件，全站长期文件最多占 200 个名额。长期文件一直占着名额，所以有上限；全站按名额算，是为了防止长期的大文件把 release 占满。所有数值都在 `wrangler.jsonc` 的 `vars` 里。

定时任务清理完还会对账：release 里有、索引里没有的 `fb_` 资产（孤儿）创建超过 6 小时（`ORPHAN_HOURS`）就删掉。孤儿来自中断的分段上传、写索引失败的上传，以及删除时没删干净的段。对账要在 `SWEEP_ORPHANS` 设成 `true` 时才跑。本地开发的 KV 和线上不是同一份，却连着同一个 release，打开它会把线上文件当成孤儿，所以默认是关的。另外，一半以上的 `fb_` 资产都像孤儿时，对账任务认为 KV 和 release 对不上，一个都不删。

被清理的文件没有任何通知，链接直接 404。

如果真的需要更大的容量：新建一个 release，把 `RELEASE_TAG` 改成它的 tag 重新部署。旧文件不受影响，下载和删除都按资产 id 走仓库级接口，与 release 无关；但自动清理按 KV 里的全部文件计数，阈值要一起调。

## 部署

```bash
cp wrangler.example.jsonc wrangler.jsonc           # 填域名、KV id、存储仓库和 release tag
npx wrangler kv namespace create filebox-users     # 已有就跳过，把 id 填进 wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN               # 私有仓库，Releases 读写权限
npx wrangler secret put SESSION_SECRET             # 随机长串，例如 openssl rand -hex 32
FILEBOX_PASSWORD='…' node scripts/setup.mjs alice --role admin --remote
npx wrangler deploy
```

`wrangler.jsonc` 被 `.gitignore` 排除，域名、KV 命名空间 id、存储仓库名都只留在本地。

想推送后自动部署，可以在 Cloudflare 面板里把 Worker 连到自己的仓库（Workers Builds）。仓库里没有 `wrangler.jsonc`，所以构建命令要先从存放配置的私有仓库把它读下来，用一个只读的 fine-grained PAT（只授权配置仓库，Contents: Read-only），存成构建密钥 `CONFIG_TOKEN`：`curl -fsSL -H "Authorization: Bearer $CONFIG_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/<配置仓库>/contents/wrangler.jsonc?ref=main" -o wrangler.jsonc && npm run check && node test/evict.test.mjs`，部署命令用 `npx wrangler deploy`。这样配置只有一份，改了推送配置仓库就行。可观测性的设置要整段写进 `wrangler.jsonc`，在面板上改的会被下一次部署覆盖。仓库是公开的话，不要改用它自己的 GitHub Actions 部署：部署输出里有域名和绑定的变量，公开仓库的 Actions 日志谁都能看。

存储侧需要一个私有仓库，和仓库里一个承载资产的 release，仓库名和 tag 填在 `wrangler.jsonc` 的 `GITHUB_REPO`、`RELEASE_TAG`，两项都没有默认值。不要用公开仓库存文件：公开仓库的 release 谁都能列出和下载，文件列表就公开了。release 要手工建：

```bash
gh release create <tag> -R <存储仓库> --title storage --notes "filebox 存储"   # 仓库不能为空
```

Worker 用 zone 路由接管一个主机名：DNS 里给这个主机名加一条开了代理的占位 A 记录（比如 `192.0.2.1`），`routes` 写 `<主机名>/*`。workers.dev 和预览地址都要关掉，原因写在 `wrangler.example.jsonc` 的注释里。挂在现有子域的路径下则同时改 `routes` 和 `BASE_PATH`。

登录接口的限流要在 zone 上另配一条速率限制规则，仓库里没有它的配置。

`setup.mjs` 是唯一的建号入口，没有开放注册，也没有「第一个登录的人自动成为管理员」这类引导逻辑。口令只从 `FILEBOX_PASSWORD` 或 stdin 读，不写进 shell 历史。

## 本地开发

```bash
cp .dev.vars.example .dev.vars     # 填 GITHUB_TOKEN 和 SESSION_SECRET；ENFORCE_HTTPS 和 SWEEP_ORPHANS 保持 false
FILEBOX_PASSWORD='…' node scripts/setup.mjs admin --role admin
npx wrangler dev --local-upstream 127.0.0.1:8787
```

本地 KV 落在 `.wrangler/state`，与线上互不影响（`--remote` 才写线上）。不加 `--local-upstream` 的话，wrangler 会把请求地址改写成路由里的主机名，接口返回的下载地址和 `/filebox` 脚本里的默认地址都会指向线上。

## 命令行

客户端是 `scripts/filebox`，Worker 在 `/filebox` 下发同一份脚本，并把脚本里的默认站点地址填成当前站点：

```bash
curl -fsSL https://<站点>/filebox -o filebox && chmod +x filebox   # 放进 PATH 里的任意目录
filebox login                      # 粘贴在 /admin 里生成的 token，存进 ~/.config/filebox/token
                                   # 也可以不存文件，改用 export FILEBOX_TOKEN=fb_…

filebox whoami                          # 检查 token：打印用户名、角色和 token 的名字
filebox put ./photo.jpg album/2026.jpg   # 成功后打印下载地址；同名默认拒绝，-f 覆盖
filebox ls                               # 列出根目录下一层；ls album 列出 album 下一层
filebox ls -r                            # 列出全部文件；ls -r album 只列 album 下面的
filebox url album/2026.jpg               # 打印可直接分享的下载地址
filebox get album/2026.jpg ./out.jpg     # 本地已有同名文件时拒绝
filebox mkdir album/2027
filebox rm album/2026.jpg
filebox mv album/2026.jpg album/新年.jpg # 重命名；目标是已有目录或以 / 结尾时移进去，mv a.jpg / 移回根目录
filebox rmdir album/2027                 # 只删空目录
filebox keep album/2026.jpg              # 设为长期，不参与自动清理；unkeep 取消
filebox update                           # 从站点下载新版，替换这个脚本自己
filebox version
filebox install-finder                   # macOS：Finder 右键菜单加「上传到 filebox」；uninstall-finder 去掉
```

token 先读环境变量 `FILEBOX_TOKEN`，没有再读 `filebox login` 存下的 `~/.config/filebox/token`（设置了 `XDG_CONFIG_HOME` 时放在它下面），目录和文件只有自己能读。`login` 从标准输入读 token，不经过命令行参数，所以不会进 shell 历史；终端里输入时不回显，也可以用 `pbpaste | filebox login` 这样从管道传进去。保存前会先调一次 `whoami`，token 不能用就不保存。`logout` 删掉这个文件。

### Finder 右键上传（macOS）

`filebox install-finder` 在 `~/Library/Services/` 下生成一个 Automator 快速操作。之后在 Finder 里选中一个或多个文件，右键 → 快速操作 → 上传到 filebox，文件会传到根目录，下载链接复制到剪贴板（多个文件一行一个），结果用系统通知显示。开始上传时先发一条通知，超过 95 MiB 的文件每传一段再发一条「第 k/N 段」，用来判断是不是还在传。同名文件不覆盖，会在通知里报错；选中目录也会报错，要先打包。

快速操作运行时读不到 shell 里的环境变量，所以要先 `filebox login` 把 token 存进文件；安装时如果文件不存在、而 `FILEBOX_TOKEN` 可用，会自动替你存一份。快速操作调用的不是脚本本身，而是安装时复制到 `~/Library/Application Support/filebox/filebox` 的副本：脚本放在「文稿」「桌面」「下载」这类受隐私保护的目录里（或者经软链接指到那里）时，快速操作读不了它，会报 `Operation not permitted`。`filebox update` 会顺带更新这份副本，脚本挪了位置也不用重装。`uninstall-finder` 删掉快速操作和副本。

`ls` 的第一行是整个账号的用量，例如 `alice：12 个文件，占用名额 20/300，长期 3/20 个`；下面先列子目录（`dir` 开头），再列文件，长期文件标着 `keep`。路径都是完整路径，可以直接拿去 `get`、`rm`。

`mv` 只改索引，不重新上传，大文件也是一瞬间完成。下载地址的路径会变，旧链接直接 404，`?v=` 后面的版本号不变；长期标记和创建时间保留。目标位置已有文件时拒绝，要覆盖先 `rm`。只能移动单个文件，不能移动目录。

超过 95 MiB 的文件，`put` 会自动用 `dd` 切段，逐段上传，每段打印一行进度，最后提交。上传中断的话，已经传上去的段会在 6 小时后被对账任务删掉，重新 `put` 一次即可。`get` 不用管分段，站点会拼成一个文件返回。

`update` 先找到脚本自己在磁盘上的位置（通过 PATH 里的软链接调用也能找到真实文件），把新版下载到同一个目录的临时文件里，检查过开头的 `#!`、版本号和 `bash -n` 语法后，再用 `mv` 原子替换。脚本所在目录不可写时会拒绝，并打印手工更新的命令。`update` 和 `version` 不需要 token。站点下发脚本时，会把脚本内容的摘要填进 `VERSION`，所以版本号只是用来比较新旧的标识，没有大小顺序。

脚本发出的请求都带 `User-Agent: filebox-cli/<版本号>`，在访问统计里可以据此区分命令行、浏览器和直接用 curl 的请求，也能看出还有哪些旧版本在用。UA 可以伪造，只用于统计，不参与鉴权。

用仓库里的 `scripts/filebox` 时，要另外设置 `FILEBOX_URL`。

`put` 和 `get` 在终端里会显示 curl 的进度条。stderr 被重定向时不显示；设置 `FILEBOX_QUIET=1` 也可以关掉。上传的进度条走到 100% 只说明文件到了 Cloudflare，之后还要等 Worker 把它写进 GitHub，写完才打印下载地址。网页端上传同样有进度条，到 100% 后会提示「正在写入 GitHub」；下载交给浏览器自己的下载进度。

脚本要在 macOS 自带的 Bash 3.2 上运行，只依赖 curl、od 和 sed，分段上传另外要用 dd、wc、mktemp，`login` 要用 mkdir，有 `file` 命令时用它判断文件类型，没有就按 `application/octet-stream` 上传；Finder 右键菜单另外用到 macOS 自带的 osascript 和 pbcopy。它不用 python3 或 jq；`ls`、`url`、`put` 需要的结果由服务端通过 `?format=text` 直接返回纯文本。2026-11-15 用 Bash 3.2.57（与 macOS 自带的版本相同）跑过全部命令，包括 250 MB 文件的分段上传和下载。

## HTTP 接口

管理页内部的接口（会话 cookie）：

```
POST   /admin/api/login          {username, password}
POST   /admin/api/logout
GET    /admin/api/me
GET    /admin/api/users          POST /admin/api/users
POST   /admin/api/users/:name/password|disable|enable
DELETE /admin/api/users/:name
GET    /admin/api/tokens         POST /admin/api/tokens {label}
DELETE /admin/api/tokens/:key
```

文件接口（会话 cookie 或 `Authorization: Bearer`）：

```
GET    /api/whoami[?format=text]          当前身份和所用 token；/api/me 是旧名字，仍然可用
GET    /api/files[?user=][&format=text]   管理员可加 ?user=
GET    /api/url?path=…[&format=text]      取可直接下载的地址
POST   /api/upload?path=…[&overwrite=1][&format=text]
                                         PUT 也行。请求体就是文件字节，必须带 Content-Length，
                                         最多一段（默认 95 MiB），更大的文件走分段上传
GET    /api/upload/limits[?format=text]   段长和单文件上限；text 格式是一行「段长 上限」
POST   /api/upload/part?path=…&id=…&n=…&of=…&size=…[&format=text]
                                         上传第 n 段（共 of 段，文件总长 size），返回一张回执
POST   /api/upload/complete?path=…[&overwrite=1][&format=text]
                                         请求体是全部回执，一行一张；可带 X-File-Type 头
DELETE /api/file?path=…
POST   /api/move?from=…&to=…[&format=text]
                                         重命名或移动；to 以 / 结尾或是已有目录时移进去，目标已有文件返回 409
POST   /api/folder                       {"path": "a/b"}，或者把 path 放在查询串里
DELETE /api/folder?path=…                只删空目录
POST   /api/keep?path=…[&format=text]    设为长期；超过上限返回 409
DELETE /api/keep?path=…[&format=text]    取消长期
```

`/api/files` 的 JSON 里有 `limits`（`files`、`assets`、`maxAssets`、`keep`、`maxKeep`，`assets` 是已占的名额），每个文件有 `keep` 字段和 `parts` 字段（占几个名额）。上传在 release 满了时返回 507，响应里的 `evicted` 是当场清理掉的文件数，大于 0 时重传即可。

分段上传的规矩：

- 除最后一段外，每段都必须正好是段长，段数 `of` 必须等于总长除以段长向上取整，最多 22 段。服务端按这些数核对每一段的 `Content-Length`。
- `id` 是客户端随机取的上传 id（8 到 64 个 `[A-Za-z0-9_-]`），同一个文件的各段用同一个 id。
- 回执由服务端签名，里面有用户、路径、上传 id、段号和这一段的资产 id，约 5 小时后过期（比孤儿判定时长少 1 小时）。`complete` 只接受同一个用户、同一个路径、同一次上传、段号齐全的回执。
- 中间不写 KV，`complete` 时才写一次索引。同名文件存在又没带 `overwrite=1` 时，`complete` 返回 409，并删掉刚传上去的段。

加 `format=text` 时，`files` 返回逐行的文件列表，`url` 和 `upload` 只返回一行完整的下载地址。

公开下载：`GET|HEAD /f/<用户>/<路径>`，支持 Range。`?v=` 后面是 GitHub 资产 id，每次上传都会换一个新的。`v` 和当前版本一致时，内容不会再变，响应缓存一年（`immutable`）；不带 `v` 或 `v` 是旧版本时，返回当前内容，缓存 7 天。

命令行脚本：`GET|HEAD /filebox`，不需要登录。

## 安全设计

- 口令用 PBKDF2-SHA256，迭代次数可配（`PASSWORD_ITERATIONS`，默认 100000），盐随机 16 字节。2026-11-14 在线上实测，登录耗时约 0.8–0.9 秒，没有触发免费计划的 CPU 限制。
- `/admin/api/login` 由 zone 上的速率限制规则保护，阈值在 Cloudflare 面板里配，不在仓库里。
- 只走 HTTPS：http 的 GET/HEAD 跳转到 https，http 的写请求直接返回 403；https 响应带 HSTS 头（一年，只作用于这个主机名）。
- `/filebox` 往脚本里填站点地址前，先用正则校验，只接受 `https?://主机名[:端口][/路径]`，不合格就不填。`new URL()` 会接受像 `x.com$(id)` 这样的主机名，不校验就等于让请求头往用户要执行的脚本里注入命令。
- 会话是无状态 HMAC 签名 cookie：`HttpOnly; Secure; SameSite=Strict`，7 天。每次请求都回查 KV，所以停用账号、改角色、删账号立刻生效（在 KV 一致性窗口内）。
- 改口令会让该账号的所有会话失效（账号记录里的 `ver` 自增），同时吊销它的所有 token。
- 删除账号会同时删除其名下全部文件（GitHub 资产和索引）与 token。
- token 是 192 位随机数，KV 里只存 SHA-256 摘要，明文只在创建时返回一次。
- 浏览器的写操作校验同源 `Origin`；口令只接受 JSON 请求体。
- 路径逐段校验，拒绝 `..`、空段、控制字符和反斜杠；下载路由里解码后仍含 `/` 的段直接拒绝。
- 上传的主动内容（HTML/SVG/JS/XML）一律 `Content-Disposition: attachment` 加 `nosniff`，并带 `CSP: default-src 'none'; sandbox`；只有图片、音视频、纯文本、PDF 内联展示。管理页另有自己的 CSP 和 `frame-ancestors 'none'`。
- 跟随 GitHub 的签名跳转时手工剥离 `Authorization`，凭据不会发到 `release-assets.githubusercontent.com`。

## 已知限制

- **登录限流只按 IP 计数**。免费计划的速率限制规则只能按 IP 计数，换着 IP 爆破拦不住，所以口令要够长。Worker 自己不记失败次数：每次失败都写 KV 的话，猜不中口令的爆破也能把每天 1,000 次的免费写额度耗光，当天就没法上传。
- **退出登录不吊销已签发的 cookie**：会话是无状态的，被窃取的 cookie 在 7 天内仍然有效。要立即作废某账号的所有会话，改一次口令。
- **删除不是立即全网生效**：Worker 每次都先查 KV，删除后新的请求立即 404；但已经缓存过的浏览器会继续用旧内容，不带版本号的地址最长 7 天，带 `?v=` 的地址最长一年。
- 上传要求 `Content-Length`，不能用 chunked 请求体（GitHub 的资产上传接口本身也要求长度）。
- 单文件最大 2 GiB（`MAX_FILE_BYTES`），同时不能超过 22 段。段数上限来自下载：每段要花 2 个外部子请求，免费计划每次调用最多 50 个。
- **分段的大文件不进边缘缓存**，每次下载都从 GitHub 取：Cache API 单个对象最大 512 MB，而且整段写缓存很费子请求。拼接只是在 Worker 里转发字节，CPU 用量在线上还没有实测过。
- 旧版命令行脚本没有 `update` 命令，也不会分段上传，要手工重新下载一次 `/filebox`。
- 索引是 KV 上的扁平键，用户多、文件多时列目录会变慢并消耗 KV list 配额；这个设计的目标是几百到几千个文件。
- **个人名额上限是软的**：每小时才检查一次，两次检查之间一个用户可以暂时超过 300 个。
- **长期文件的计数不是强一致的**：两个请求同时设置长期，可能略超上限（KV 最终一致）。
- **release 满了时的兜底靠猜**：GitHub 没有文档说明 release 满了返回什么，代码把上传返回的 422 当作「满了」。正常情况下定时任务会把数量控制在 950 以内，碰不到这条路径。
- **孤儿资产不计入名额**：清理按 KV 索引计数，孤儿要等对账任务删掉。对账没打开时，它们会一直占着 release 的位置。几乎是空的 release 里如果有孤儿，会被「一半以上像孤儿就不删」这条保护挡住，要等别的文件多起来才会被删。
- 资产名里的用户部分没有做转义隐藏：知道 URL 的人能看到 `fb_<用户>_` 前缀，这不算敏感信息（下载本来就是公开的）。

## 目录

```
src/
  worker.js    路由与首页
  admin.js     管理页（单页应用）与账号/token 接口
  files.js     文件管理 API
  download.js  公开下载、Range、缓存、分段拼接
  access.js    身份解析（token / 会话）、同源校验
  auth.js      口令哈希、会话签名、token 生成
  users.js     KV：用户、token
  store.js     KV：文件与目录索引（文件键带 metadata）
  evict.js     自动清理与孤儿对账（定时任务）
  github.js    Releases 资产的上传/删除/下载
  names.js     路径与文件名校验
  config.js    配置
  http.js      响应工具
scripts/
  setup.mjs    引导管理员账号
  filebox      命令行客户端（Bash 3.2 兼容，Worker 在 /filebox 下发）
test/
  evict.test.mjs  挑选待删文件、找孤儿、Range 换算到段、配置默认值的单元测试（node test/evict.test.mjs）
```

## 许可证

[Apache License 2.0](LICENSE)，版权声明见 [NOTICE](NOTICE)。
