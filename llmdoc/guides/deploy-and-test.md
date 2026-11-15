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

测的时候用这个 bash 显式运行脚本（`$D/bash-3.2.57/bash ./filebox …`）。PATH 换成一个目录，里面只放 curl、od、sed、basename、dd、wc、mktemp、cmp、cat、mv、cp、rm、head 的软链接，用来确认脚本没有偷偷用到别的工具。改完脚本还要跑一遍 `shellcheck -s bash scripts/filebox`。

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
gh release create _test_chunk -R <存储仓库> --title test --notes test
npx -y wrangler@4.161.0 dev --port 8801 --ip 127.0.0.1 --local-upstream 127.0.0.1:8801 --test-scheduled \
  --var RELEASE_TAG:_test_chunk --var PART_BYTES:1048576 --var ORPHAN_HOURS:0.05
```

- `PART_BYTES` 设成 1 MiB，几 MB 的文件就能切成好几段。不设的话用默认的 95 MiB，要传 200 MB 以上的文件才能测到 3 段。
- `ORPHAN_HOURS` 设成 0.05（3 分钟），回执的有效期是它的一半，约 1.5 分钟。它必须大于一次分段上传实际要花的时间，设得太小时 `complete` 会报「回执无效或已过期」。
- 对账只在打开时跑。测它时临时把 `.dev.vars` 里那一行改成 `"true"`，测完马上改回来；`--var` 和 `.dev.vars` 哪个优先没有验证过，不要只靠 `--var`。命令行上必须同时有 `--var RELEASE_TAG:_test_chunk`：KV 是本地的，release 是临时的，这时打开才不会删到线上文件。
- 要确认的事：分段文件的 sha256 和原文件一致；跨段的 Range 请求结果正确；覆盖、删除、自动清理都删掉了全部段；中断的上传留下的段在判定时长之后被对账删掉，而索引里有的段没被动。
- 测完删掉临时 release 和它的 tag：`gh release delete _test_chunk -R <存储仓库> --cleanup-tag --yes`。然后确认存文件的那个 release 资产数没变。

## 部署

`wrangler.jsonc` 不进仓库。第一次部署先 `cp wrangler.example.jsonc wrangler.jsonc`，填上域名、KV 命名空间 id、存储仓库和 release tag。线上用的那份放在单独的私有仓库里维护，源码目录里的 `wrangler.jsonc` 是指向它的软链接。wrangler 按软链接所在的目录解析 `main`，所以部署照常在源码目录运行。

```bash
npx -y wrangler@4.161.0 secret put GITHUB_TOKEN
npx -y wrangler@4.161.0 secret put SESSION_SECRET
FILEBOX_PASSWORD='…' node scripts/setup.mjs <名> --role admin --remote
npx -y wrangler@4.161.0 deploy
```

`GITHUB_TOKEN` 应该用 fine-grained PAT：只授权存储仓库这一个仓库，权限给 Contents: Read and write（release 资产的读写归在 Contents 下）。不要用 `gh auth token` 的 OAuth token，它能访问账号下所有仓库。

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
