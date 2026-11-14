# 项目概览

## 目标

一个依托 GitHub 与 Cloudflare 的文件箱：授权用户登录管理页上传、管理自己名下的文件和目录，生成 API token 给脚本用；任何人都可以通过链接下载，不需要校验。

## 用户约束（来自需求讨论，代码里看不出来）

- **不能产生计费**。用户明确拒绝 R2：超出免费额度会按量扣费。所有组件都选「超额即报错」的免费资源（Workers 免费版、KV 免费版、GitHub release）。引入任何新的 Cloudflare 产品前先确认它在免费计划下超额是报错还是计费。
- **任意文件类型**，图片之外的文件也要能存。
- **临时存储，没有持久化需求**，所以满之前自动删最旧的文件。用户 2026-11-15 定的规则：
  - 全站按时间删最旧的，另外每人有文件数上限（默认 300），一个人传得多，只会挤掉他自己的旧文件。
  - 可以把文件设为长期，每人最多 20 个，全站最多 200 个。
- **不开放注册**。账号只能由管理员在管理页创建，或用 `scripts/setup.mjs` 引导。
- **下载公开**，但文件列表不公开：只有登录用户能看到自己的列表。
- 源码仓库是公开的，所以凭据和部署信息都不能进仓库：`.dev.vars` 和 `wrangler.jsonc` 只留在本地，文档里不写域名、存储仓库名、KV 命名空间 id 和限流阈值。文件字节存在另一个私有仓库的 release 里，这个仓库不能公开，原因见 `README.md` 的「部署」一节。
- **命令行脚本 `scripts/filebox` 要尽可能兼容**，最低要能在 macOS 自带的 Bash 3.2 上运行。
  - 不用 Bash 4 以后的语法（关联数组、`mapfile`、`${var,,}` 等）。
  - 不依赖 python3 或 jq，macOS 默认不带它们。
  - 不用 curl 7.76 才有的 `--fail-with-body`。
  - 需要解析的响应让服务端用 `?format=text` 返回纯文本。
- 命令名叫 `filebox`，不带 `.sh` 后缀。脚本由 Worker 在 `/filebox` 下发，下发时会把默认站点地址填上；仓库里的副本没有默认地址，要另外设 `FILEBOX_URL`。

## 部署状态

以本地的 `wrangler.jsonc`、`npx wrangler deployments list` 和 Cloudflare 面板为准，本文不记录部署信息。

- 存储：私有仓库里的一个 release，仓库和 tag 见 `wrangler.jsonc` 的 `GITHUB_REPO`、`RELEASE_TAG`。
- KV 命名空间：`filebox-users`，id 见 `wrangler.jsonc`。
- secrets：`GITHUB_TOKEN`、`SESSION_SECRET`。
- 路由：zone 路由接管一个主机名，见 `wrangler.jsonc` 的 `routes`；workers.dev 关闭。
- 登录限流：zone 上的速率限制规则，只能在 Cloudflare 面板里查看。
