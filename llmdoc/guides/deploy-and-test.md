# 部署与测试

## 本地开发

```bash
cp .dev.vars.example .dev.vars           # 填 GITHUB_TOKEN、SESSION_SECRET（openssl rand -hex 32）；ENFORCE_HTTPS、SWEEP_ORPHANS 保持 "false"
FILEBOX_PASSWORD='…' node scripts/setup.mjs admin --role admin    # 写本地 KV
npx -y wrangler@4.161.0 dev --port 8801 --ip 127.0.0.1 --local-upstream 127.0.0.1:8801
```

- `--local-upstream` 不能省。省掉的话，wrangler 会把 `request.url` 改写成路由里的 `http://<主机名>`，结果有三个：
  - 接口返回的下载地址指向线上；
  - `/filebox` 下发的脚本里默认地址也是线上，本地测命令行时请求会打到线上；
  - 本地开着 `ENFORCE_HTTPS` 时，请求会被跳转到 https。
- 测命令行时显式设置 `FILEBOX_URL`，不要依赖脚本里的默认地址。
- 本地 KV 在 `.wrangler/state`，与线上隔离；加 `--remote` 才会写线上。
- **本地的 GitHub 后端是真的**：本地上传的文件会进线上 release。测试完要用 API 删掉（删 API 会同时清资产和索引），然后用 `gh api repos/<存储仓库>/releases/tags/<tag> --jq '.assets|length'` 确认数量回到测试前。
- 本地是 HTTP，cookie 带 `Secure`。curl 照样会发，浏览器会不会发取决于实现（多数浏览器把 localhost 视为安全上下文）。
- 登录限流在 zone 层，本地测不到。
- `.dev.vars` 里的 `SWEEP_ORPHANS` 必须是 `"false"`，理由见 `must/invariants.md` 第 16 条。

## 测命令行脚本的兼容性

`scripts/filebox` 要能在 macOS 自带的 Bash 3.2.57 上运行。本机的 bash 版本太新，测不出问题，要自己编一个 3.2.57。

```bash
D=$(mktemp -d) && cd "$D"
curl -fsSLO https://mirrors.tuna.tsinghua.edu.cn/gnu/bash/bash-3.2.57.tar.gz   # ftp.gnu.org 在这台机器上连不上
sha256sum bash-3.2.57.tar.gz   # 3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4
tar xzf bash-3.2.57.tar.gz && cd bash-3.2.57
CC="gcc -std=gnu89" CFLAGS="-O1 -w" ./configure --without-bash-malloc
make CC="gcc -std=gnu89" CFLAGS_FOR_BUILD="-std=gnu89 -w"   # 新版 gcc 默认的 C 标准编不过 K&R 风格的旧代码
```

测的时候用这个 bash 显式运行脚本（`$D/bash-3.2.57/bash ./filebox …`）。PATH 换成一个目录，里面只放 curl、od、sed、basename、dd、wc、mktemp、cmp、cat、mv、cp、rm、head、mkdir 的软链接，用来确认脚本没有偷偷用到别的工具。改完脚本还要跑一遍 `shellcheck -s bash scripts/filebox`。

脚本里所有的 curl 调用都要带 `-A "$UA"`，`UA` 是 `filebox-cli/$VERSION`。新加 curl 调用时别漏掉，否则这些请求在访问统计里会混进直接用 curl 的流量。服务端不能根据 UA 放行或区别对待请求。

变量后面紧跟中文（包括全角标点）时必须写成 `${name}`。macOS 的 Bash 3.2 在 UTF-8 locale 下会把中文的首字节算进变量名，`"$new（"` 被读成变量 `new\xef`，在 `set -u` 下报 unbound variable。Linux 上编的 Bash 3.2 测不出这个问题，因为 glibc 在 UTF-8 locale 下不把单个高位字节当成字母。下面这条命令应当没有输出：

```bash
perl -ne 'print "$.: $_" if /\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]/' scripts/filebox
```

要在 Linux 上复现，就生成一个 Latin-1 locale，用它运行 Bash 3.2。Latin-1 下 glibc 会把 `0xEF` 这类字节当成字母，和 macOS 的表现一样：

```bash
mkdir loc && localedef -i en_US -f ISO-8859-1 loc/en_US.ISO-8859-1
LOCPATH=$PWD/loc LC_ALL=en_US.ISO-8859-1 $D/bash-3.2.57/bash ./filebox version
```

## 测自动清理

挑哪些文件删由 `planEviction` 决定，它是纯函数，改了它先跑单元测试：

```bash
node test/evict.test.mjs
```

真正的删除要在本地 dev 里测。默认阈值是几百个文件，本地传不了这么多，启动时用 `--var` 把阈值调小，再加 `--test-scheduled` 打开手动触发定时任务的入口：

```bash
npx -y wrangler@4.161.0 dev --port 8801 --ip 127.0.0.1 --local-upstream 127.0.0.1:8801 --test-scheduled \
  --var MAX_ASSETS_PER_USER:4 --var MAX_KEEP_PER_USER:2 --var MAX_KEEP_TOTAL:3 --var EVICT_HIGH:6 --var EVICT_LOW:4
curl "http://127.0.0.1:8801/__scheduled?cron=17+*+*+*+*"
```

- 每次触发，dev 的输出里会有一行 `{"cron":…,"total":…,"assets":…,"planned":…,"evicted":…,"sweep":…}`，依次是清理前的文件数、名额数、计划删的文件数、实际删掉的文件、对账结果。
- 建两个用户各传几个文件，把其中一两个设为长期，再触发。要确认三件事：长期文件没被删；先删的是超出个人上限的那个用户的旧文件；被删文件的下载地址返回 404。再触发一次应当什么都不删。
- 本地上传的文件会进线上 release（见「本地开发」）。测完把剩下的测试文件删掉，确认 release 资产数回到测试前。
- 上传收到 422 时清理一批再返回 507 的那条路径，本地触发不了，见 `memory/doc-gaps.md`。

## 测分段上传和孤儿对账

分段和对账都会往 release 里写真实资产，要用一个临时 release，不要碰存文件的那个：

```bash
gh release create _test_chunk -R <存储仓库> --title test --notes test --latest=false
npx -y wrangler@4.161.0 dev --port 8801 --ip 127.0.0.1 --local-upstream 127.0.0.1:8801 --test-scheduled \
  --var RELEASE_TAG:_test_chunk --var PART_BYTES:1048576 --var ORPHAN_HOURS:0.05
```

- `PART_BYTES` 设成 1 MiB，几 MB 的文件就能切成好几段。不设的话用默认的 95 MiB，要传 200 MB 以上的文件才能测到 3 段。
- `ORPHAN_HOURS` 设成 0.05（3 分钟），回执的有效期是它的一半，约 1.5 分钟。它必须大于一次分段上传实际要花的时间，设得太小时 `complete` 会报「回执无效或已过期」。
- 对账只在打开时跑。测它时临时把 `.dev.vars` 里那一行改成 `"true"`，测完马上改回来；`--var` 和 `.dev.vars` 哪个优先没有验证过，不要只靠 `--var`。命令行上必须同时有 `--var RELEASE_TAG:_test_chunk`：KV 是本地的，release 是临时的，这时打开才不会删到线上文件。
- 要确认的事：分段文件的 sha256 和原文件一致；跨段的 Range 请求结果正确；覆盖、删除、自动清理都删掉了全部段；中断的上传留下的段在判定时长之后被对账删掉，而索引里有的段没被动。
- 测完删掉临时 release 和它的 tag：`gh release delete _test_chunk -R <存储仓库> --cleanup-tag --yes`。然后确认存文件的那个 release 资产数没变。建临时 release 时要带 `--latest=false`：不带的话 Latest 标记会转到临时 release 上，删掉它之后 GitHub 不会把标记还给存文件的 release。filebox 按 tag 找 release，不受影响，但仓库页面会变样，要用 `gh release edit <tag> --latest` 改回来。

## 测 Finder 右键菜单

`install-finder` 和 `finder-upload` 只在 macOS 上有意义，但在 Linux 上可以测到快速操作的执行这一步，Finder 本身认不认这个快速操作只能在 Mac 上看：

- 准备一个假的 `$HOME`，里面建好 `Library` 目录；PATH 前面放一个目录，里面是假的 `osascript`（把参数追加到日志文件）和 `pbcopy`（把标准输入写进文件），`install-finder` 靠 `osascript` 判断是不是 macOS。
- 用 Python 的 `plistlib` 读生成的 `Info.plist` 和 `document.wflow`，确认格式合法，并取出 `COMMAND_STRING`。
- 模拟 Automator 运行：`env -i HOME=<假 HOME> PATH=<假命令目录>:/usr/bin:/bin /bin/bash -c "$COMMAND_STRING" bash <文件…>`。`env -i` 是为了确认它不依赖 shell 里的 `FILEBOX_TOKEN`，只靠 `login` 存下的文件。
- 要看的情况：多个文件一起传、文件名带引号和中文、同名文件已存在、选中目录、目录和文件混选。通知日志里的标题和正文、剪贴板文件里的链接都要对得上。
- 用伪终端测 `login` 的交互输入时（`script -qec`），预先灌进去的 token 会在关掉回显之前被回显出来，这是测法的问题，手动粘贴时不会出现。

Linux 上测不到的两件事，在 Mac 上踩过：

- **菜单不出现。** 系统能登记上服务（`pbs -dump` 里看得到），Finder 的右键菜单里却没有。macOS 15 上，手写的 plist 缺了 `Info.plist` 的 `NSIconName`、`document.wflow` 的 `applicationPaths` 和动作的 `arguments` 等字段。macOS 26.5 上同样的字段都齐了，菜单仍然不出现，`AMApplicationBuild` 还是 `528`、`processesInput` / `serviceProcessesInput` / `useAutomaticInputType` 还写成整数 `0`；在 Automator 里打开按 ⌘S 保存一次（Automator 把 `AMApplicationBuild` 升到 `534`，三项改写成布尔 `false`）菜单就出来了。两种情况都是 Automator 存一次即好。现在脚本生成的两个文件照着 macOS 26 的 Automator 保存出来的内容写，只有界面显示用的本地化字符串不同（`ActionName`、`Keywords`、`AMApplication`）。改这两个文件时，在 Mac 上用 Automator 存一份，用 `plistlib` 把两边展开成键路径逐项比对，除了这几个字段、`location` 和 `COMMAND_STRING` 外应当没有差别。Automator 打开后顶部显示「位于 任何应用程序」而不是「访达」，就说明 `workflowMetaData` 不对。
- **`pbs` 不在 PATH 里了。** macOS 26 上 `pbs -dump` 报 `command not found`，要用 `/System/Library/CoreServices/pbs -dump`。
- **`Operation not permitted`。** 快速操作的进程读不了「文稿」「桌面」「下载」这些受隐私保护目录里的文件，脚本放在那里（或者经软链接指到那里）时，bash 打不开脚本。所以快速操作调用的是 `~/Library/Application Support/filebox/` 下的副本，`update` 会同步它。测 `update` 时要确认副本也换成了新版。
- **token 同样会被 TCC 挡住。** 2026-11-16 在 macOS 26.5 上，右键上传报 `sed: /Users/…/.config/filebox/token: Operation not permitted`，因为 `~/.config` 是指到「文稿」里的软链接。注意 TCC 拦的是 `open()`，`[ -r ]` 用 access(2) 并不拦，所以检查 token 文件不能只靠 `-r`，要以 sed 能不能读完为准（`read_token_file`）。现在 `login` 会同时写 `~/Library/Application Support/filebox/token`，读取时前者读不出就退到后者；`update` 和 `install-finder` 发现副本缺失时会补写。

2026-11-15 在 macOS 15.7.3 上验证过：`install-finder` 之后不用另存、不用重启 Finder，菜单直接出现；脚本真身在「文稿」里时能正常运行，选中「文稿」里的文件也能上传。

## 测管理页的手机布局

宽度不超过 640px 时，管理页的表格改成一行一张卡片（`src/admin.js` 里的 `@media(max-width:640px)`）；触屏设备（`hover:none` 且 `pointer:coarse`）隐藏拖放区。改了管理页的表格或按钮后，用 Playwright 在 393×852、`isMobile`、`hasTouch` 下截文件、token、用户三个标签页，确认 `document.documentElement.scrollWidth - innerWidth` 是 0，也就是没有横向滚动。

- 截图用 `page.screenshot()`，不要加 `fullPage: true`。整页截图会临时把视口拉到整页高度，触屏的媒体查询随之不再匹配，截出来的图里会多出拖放区，和真机看到的不一样。
- 本地 KV 里的测试账号用 `setup.mjs` 建，测试文件可以只写索引（`wrangler kv key put --local`，带 metadata），不用真传到 GitHub。测完删掉。
- 「添加到主屏幕」只能在真机上验证：iPhone 的 Safari 用 `apple-touch-icon`（`/icons/180.png`），安卓的 Chrome 读 `/manifest.webmanifest`。

## 部署

`wrangler.jsonc` 不进仓库。第一次部署先 `cp wrangler.example.jsonc wrangler.jsonc`，填上域名、KV 命名空间 id、存储仓库和 release tag。线上用的那份放在单独的私有仓库里维护，源码目录里的 `wrangler.jsonc` 是指向它的软链接。wrangler 按软链接所在的目录解析 `main`，所以部署照常在源码目录运行。

```bash
npx -y wrangler@4.161.0 secret put GITHUB_TOKEN
npx -y wrangler@4.161.0 secret put SESSION_SECRET
FILEBOX_PASSWORD='…' node scripts/setup.mjs <名> --role admin --remote
npx -y wrangler@4.161.0 deploy
```

`GITHUB_TOKEN` 应该用 fine-grained PAT：只授权存储仓库这一个仓库，权限给 Contents: Read and write（release 资产的读写归在 Contents 下）。不要用 `gh auth token` 的 OAuth token，它能访问账号下所有仓库。

### 推送 main 后自动部署

线上的 Worker 在 Cloudflare 面板里连着公开源码仓库（Workers Builds），推送 main 就会构建并部署，大约一分钟。所以**推送就是部署**，推之前要先按本文在本地测完。

- 公开仓库里没有 `wrangler.jsonc`。构建命令先用构建密钥 `CONFIG_TOKEN` 从存放线上配置的私有仓库读出这个文件，再跑 `npm run check` 和单元测试，有一步失败就不部署：
  `curl -fsSL -H "Authorization: Bearer $CONFIG_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/<配置仓库>/contents/wrangler.jsonc?ref=main" -o wrangler.jsonc && npm run check && node test/evict.test.mjs`
  部署命令是 `npx -y wrangler@4.161.0 deploy`。
- 配置只有私有仓库里那一份。改了配置、推送私有仓库后，下一次构建就用新配置；只改配置不改源码时，在面板里重试一次构建。
- `CONFIG_TOKEN` 是单独的 fine-grained PAT，只授权配置仓库，权限只有 Contents: Read-only，有过期时间。不复用 Worker 运行时的 `GITHUB_TOKEN`：构建环境每次都从 npm 下载并执行 wrangler，环境变量泄露的风险比运行时大；只读的 token 泄露了只能读，可读写的还能删掉存的文件、改掉部署配置。两个分开，过期和吊销也互不影响。token 不对或者过期时，curl 的 `-f` 让构建直接失败，不会拿错误的配置去部署。
- 最早的做法是把压缩后的配置存进构建密钥，改配置时要手动同步两份，容易漏。带注释的原文转 base64 后约 5 KB，面板保存时还会报「内部错误」。
- **可观测性要在 `wrangler.jsonc` 里整段写全**（`logs`、`traces`、`issues` 等）。部署时 wrangler 把这一段原样交给 Cloudflare，在面板上改的设置会被下一次部署覆盖；只写 `{ "enabled": true }` 的话，面板上开的跟踪和实时问题都会被关掉。2026-11-15 实际被覆盖过一次。
- 非生产分支的构建是关着的。打开的话，别的分支和 PR 也会往这个 Worker 上传版本。
- 构建监视路径排除了 `llmdoc/**`、`.gitignore`、`LICENSE`、`NOTICE`、`README.md`，只改文档的推送不会触发部署。新加只放文档的文件或目录时，要不要也排除掉，在面板里改。
- 用 GitHub 上公开仓库自己的 Actions 部署不行：`wrangler deploy` 的输出里有路由和绑定的变量，公开仓库的 Actions 日志谁都能看到。Workers Builds 的日志只在面板里。
- 本地手动 `wrangler deploy` 照样能用，但下一次推送会按仓库里的代码重新部署。没推送的本地改动，不要指望它们留在线上。
- 构建部署出的版本，在 `wrangler deployments list` 里和手动部署的看不出区别（来源都是 `wrangler`）。要看是不是构建触发的，去面板里看构建记录。

## 线上冒烟测试

冒烟测试按下面的顺序做，每一步都要看到预期结果。

1. `GET /healthz` 返回 200；`http://` 开头的地址返回 301，跳转目标是 `https://`。
2. 登录 `/admin`，确认能看到文件、token、用户三个标签页。
3. 生成一个 token，`curl -fsSL <站点>/filebox -o filebox` 下载脚本，确认里面的 `DEFAULT_URL` 是 `https://` 开头的站点地址，`VERSION` 不是 `dev`。`filebox whoami` 应当打印用户名和 token 的名字。用它 `put` 一个小文件（应当打印下载地址），再 `get` 下来比对 sha256。改过分段相关的代码时，再传一个大于 95 MiB 的文件，同样比对 sha256。
4. 不带任何凭据下载这个文件的链接，确认是 200。
5. 带 `Range` 头请求，确认是 206，长度正确。
6. 用错误的 token 调 `/api/files`，确认是 401。
7. 删除测试文件，确认 release 资产数回到原值；吊销测试 token。

## 绑定域名

接法分两步。

1. 在 zone 的 DNS 里给主机名加一条 A 记录，内容 `192.0.2.1`，开代理（橙色云朵）。这个地址只是占位，请求到了 Cloudflare 边缘就交给 Worker，不会真的发到这个 IP。
2. `wrangler.jsonc` 的 `routes` 写 zone 路由 `<主机名>/*`，然后部署。

这里不用 `"custom_domain": true`，因为主机名上已经有 DNS 记录时，Cloudflare 拒绝创建自定义域名（错误码 100117）。这种部署失败时，wrangler 可能已经先把 workers.dev 关掉了，两个地址会同时打不开。改路由时要盯着部署输出，失败了立刻修好重新部署。

如果挂在路径下，`BASE_PATH` 要一起改。cookie 的 Path 跟着 `BASE_PATH` 走，改了以后已登录的用户要重新登录。

一级子域（`files.example.com`）能用 zone 现有的通配证书；二级子域（`a.b.example.com`）不在 `*.example.com` 的覆盖范围内。

## 登录限流规则

限流规则建在 zone 上，仓库里没有它的配置，阈值也不写进仓库。wrangler 的 OAuth token 没有 WAF 权限，调接口会返回 `Authentication error`（code 10000），只能在面板里建：Security → WAF → Rate limiting rules，匹配 URI Path equals `/admin/api/login`，计数特征选 IP，动作选 Block。

建好以后验证一次：连续 POST 十次 `https://<站点>/admin/api/login`（用户名口令随便填），前几次是 Worker 返回的 401，之后应该变成 Cloudflare 返回的 429。

免费计划下这条规则不计费，限制见 `reference/platform-limits.md`。换域名或换 zone 后要重建，并且要保持 workers.dev 关闭（见 `must/invariants.md` 第 11 条）。
