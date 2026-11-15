# llmdoc Startup

开始处理本项目时，按以下顺序阅读：

1. `llmdoc/overview/project-overview.md` — 目标、用户约束、当前部署状态
2. `llmdoc/must/invariants.md` — 不能破坏的安全与数据不变量
3. `llmdoc/architecture/storage-and-auth.md` — 存储分层与身份模型

按任务跳转：

- 要部署或排查线上问题 → `llmdoc/guides/deploy-and-test.md`
- 要判断某个用量能不能撑住、会不会产生费用 → `llmdoc/reference/platform-limits.md`
- 要接着做没解决的事 → `llmdoc/memory/doc-gaps.md`
- 要改命令行脚本 `scripts/filebox` → `llmdoc/guides/deploy-and-test.md` 的「测命令行脚本的兼容性」
- 要改分段上传、下载或孤儿对账 → `llmdoc/architecture/storage-and-auth.md` 对应的三节
