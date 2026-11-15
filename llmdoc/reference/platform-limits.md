# 平台上限

这些数字来自 Cloudflare 和 GitHub 的文档，查阅时间是 2026-11-14。平台调整额度时以官方页面为准：

- <https://developers.cloudflare.com/kv/platform/pricing/>
- <https://developers.cloudflare.com/kv/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/limits/>

## 超额行为

- Workers 免费版、KV 免费版超额后，对应操作直接报错，**不计费**；每日额度在 UTC 0 点重置。这是选它们而不选 R2 的原因。
- GitHub release 没有计费，但受合理使用政策约束，大流量分发可能被限速。

## 上限与本项目先撞到哪里

| 上限 | 数值 | 本项目里的消耗 |
| --- | --- | --- |
| Worker 请求 | 100,000 次/天 | 所有请求 |
| Worker CPU | 10 ms/请求 | PBKDF2 是最重的一步，线上实测登录没有超限。I/O 等待不计入。分段下载必须用原生流拼接，200 MiB 的文件实测 8 ms，见 `architecture/storage-and-auth.md` |
| Worker 墙钟时间 | 客户端连着就不限 | 大文件下载可以持续很久 |
| Worker 入口请求体 | 100 MB（免费 zone） | 决定了段长，`PART_BYTES` 默认 95 MiB；更大的文件分段上传 |
| Worker 内存 | 128 MB | 上传和下载都是流式，JSON 请求体有 16 KiB 上限 |
| KV 读 | 100,000 次/天 | 每次下载 1 次，每次 API 调用 1–2 次（回查用户） |
| KV 写 | 1,000 次/天 | 上传、建目录、改口令、发 token（登录失败不写） |
| KV 删 | 1,000 次/天 | 删除文件、目录、token |
| KV list | 1,000 次/天 | `/api/files` 每次 2 次以上（按 1,000 键分页），删目录 2 次，定时任务每小时 1 次（自动清理和孤儿对账共用同一次 list），设为长期 1 次 |
| KV 操作 | 每次调用 1,000 次 | 列文件靠 metadata，不逐条 get，用不到 |
| 外部子请求 | 每次调用 50 个 | Cache API 的 `put`/`match`/`delete` 也算在内，跟随跳转每一跳也算。自动清理每删一个资产花 1 个，所以一次最多删 40 个；下载分段文件每段花 2 个，所以最多 22 段 |
| Cache API 单个对象 | 512 MB | 分段文件不进缓存 |
| Cron Triggers | 每个账号 5 个，每次 10 ms CPU | 本项目用 1 个（每小时） |
| KV 键 | 512 字节 | 限制路径长度，见 `keyFits` |
| KV 存储 | 1 GB | 索引很小，用不到 |
| release 资产数 | 1,000 个 | 所有用户共用一个 release，大文件一段占一个，自动清理控制在 950 以内 |
| 单资产 | < 2 GiB | 一段一个资产，段长受 Worker 的 100 MB 限制，用不到 |
| 列 release 资产 | 每页最多 100 个 | 对账最多翻 10 页，1,000 个资产正好列完 |

最先会撞到的通常是 **KV list**（管理页每次刷新文件列表都要 list）和 **KV 写**。两者每天都只有 1,000 次。

## WAF 速率限制规则

免费计划下速率限制规则不计费，每个 zone 只能建一条。这条规则的可选项很少。

- 计数周期只能选 10 秒，拦截时长也只能选 10 秒。
- 计数特征只有 IP。
- 匹配条件只能用 URI Path 和 Verified Bot，不能按 Hostname 匹配，所以同一个 zone 下别的站点如果也有 `/admin/api/login`，会被同一条规则计数。

Workers 的 `ratelimit` 绑定在免费计划下是否计费没有查到明确说法，所以没有用。

## 资产数满了

正常情况下碰不到：定时任务每小时把全站名额控制在 950 以内。

GitHub 的文档只写了「每个 release 最多 1000 个资产」，没有写满了以后返回什么。代码假定是 422：上传收到 422 时，当场清理一批，然后返回 507。这一点没有实测过，要测得往一个测试 release 里传满 1000 个文件。

要扩容就新建一个 release，改 `RELEASE_TAG` 后重新部署。旧文件不用迁移，原因见 `architecture/storage-and-auth.md`。
