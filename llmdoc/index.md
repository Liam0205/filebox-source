# llmdoc 索引

这里是 filebox 的稳定文档，记录源码里不容易直接看出来的设计理由和不变量，以及外部平台的边界与操作流程。具体数值以 `wrangler.jsonc` 与 `src/config.js` 为准，这里只写为什么这样定。

## 启动入口

- `llmdoc/startup.md`：新会话的阅读顺序与按任务的跳转提示。

## must/

- `llmdoc/must/invariants.md`：改代码和配置前必须守住的十七条安全与数据不变量，涉及下载与缓存的先后顺序、身份怎样校验、主动内容和 GitHub 凭据怎样防止外泄，以及分段下载怎样拼接；每条都写了守住它的代码位置和破坏后的后果。

## overview/

- `llmdoc/overview/project-overview.md`：项目目标、用户约束（不用 R2、不能产生计费）和当前部署状态。

## architecture/

- `llmdoc/architecture/storage-and-auth.md`：GitHub release 存字节 + KV 存索引的分层；为什么资产名必须是不透明 id（GitHub 会改写斜杠、中文、空格）；KV 键空间与文件键的 metadata；自动清理的实现要点；重命名与移动为什么只改索引、键的写入顺序；分段上传的签名回执、分段下载的拼接、孤儿对账；身份模型（会话 cookie / API token / 账号版本号 `ver`）；目录是显式记录 + 由文件路径推出的隐式目录。

## reference/

- `llmdoc/reference/platform-limits.md`：Workers 免费版、KV 免费额度、GitHub release 的硬上限，以及每条上限在本项目里先撞到哪里；超额行为（报错而非计费）。

## guides/

- `llmdoc/guides/deploy-and-test.md`：本地开发、建管理员、部署、线上冒烟测试；怎样用 Bash 3.2 测命令行脚本，怎样在本地测自动清理、分段上传和孤儿对账，怎样在 Linux 上测 Finder 右键菜单；测试资源的清理纪律。

## memory/

- `llmdoc/memory/doc-gaps.md`：已知但未解决的问题与可能的补法（未实施）。

## 路由提示

- 找不到某个数值 → 先查 `wrangler.jsonc` 的 `vars`，再查 `src/config.js` 的默认值。
- 要改下载、缓存或响应头 → 先读 `must/invariants.md` 的第 1–4 条。
- 要改登录、会话、token → 先读 `architecture/storage-and-auth.md` 的「身份模型」一节。
- 要改自动清理或长期文件 → 先读 `architecture/storage-and-auth.md` 的「自动清理」一节和 `must/invariants.md` 第 14 条，改完按 `guides/deploy-and-test.md` 的「测自动清理」测。
- 要改 `scripts/filebox` → 先读 `overview/project-overview.md` 里的兼容性约束，改完按 `guides/deploy-and-test.md` 的「测命令行脚本的兼容性」用 Bash 3.2 测。
- 要改分段上传、分段下载或孤儿对账 → 先读 `architecture/storage-and-auth.md` 的「分段上传与回执」「分段下载」「孤儿对账」三节和 `must/invariants.md` 第 15、16、17 条，改完按 `guides/deploy-and-test.md` 的「测分段上传和孤儿对账」测。
- 「为什么不直接用资产名做路径」→ `architecture/storage-and-auth.md`。
