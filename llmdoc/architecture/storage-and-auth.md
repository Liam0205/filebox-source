# 存储与身份

## 分层

```
Worker ── KV（USERS 绑定）：用户、token、文件索引、目录
       └─ GitHub 私有仓库的 release：文件字节，一个文件一个资产
```

GitHub release 只当字节仓库用，Worker 不调 List release assets。下载和删除都用资产 id 走仓库级接口（`/repos/{repo}/releases/assets/{id}`），跟具体是哪个 release 无关，所以换 release 不影响旧文件。

## 为什么资产名必须是不透明 id

2026-11-14 实测，GitHub 会改写资产名：

| 上传时的 `name` | GitHub 存成 |
| --- | --- |
| `dir_test/a.txt` | `dir_test.a.txt` |
| `中文 name.txt` | `name.txt` |
| `a%b#c?d.txt` | `a.b.c.d.txt` |

改写既丢信息也会撞名，所以资产名不能承载路径。现在资产名和路径分开存放。

- 资产名是 `fb_<用户>_<24 位 hex>`，在 release 内唯一。
- 可读路径写进资产的 `label`（实测原样保留中文和 `/`）。KV 索引丢了的话，可以用 label 和资产名前缀重建。
- 真正的路径以 KV 索引为准。

## KV 键空间

| 键 | 值 | 写入方 |
| --- | --- | --- |
| `user:<名>` | `{name, salt, hash, iterations, role, created, disabled, ver}` | 管理页、`setup.mjs` |
| `token:<sha256 hex>` | `{user, label, created, v}` | 管理页 |
| `file:<用户>:<encodeURIComponent(路径)>` | `{path, assetId, assetName, size, type, created, keep?}` | 上传、设为长期 |
| `dir:<用户>:<encodeURIComponent(路径)>` | `{created}` | 新建目录 |

登录失败不写 KV。限流放在 zone 的速率限制规则里，见 `guides/deploy-and-test.md` 的「登录限流规则」一节。

文件键另带 metadata `{a: assetId, s: size, c: created, t: type, k?: 1}`，由 `putFile` 写入。KV list 会把 metadata 一起返回，所以列一个用户的文件、统计全站长期文件、挑最旧的文件，都只花一次 list，不用逐条 get。这一点有实际意义：每人最多 300 个文件，逐条 get 的话，刷新一次列表就是 300 次 KV 读。没有 metadata 的旧记录会回退到 get（`filesFromKeys`）。改文件记录的字段时，要同时改 `fileMeta` 和 `fromMeta`，metadata 上限 1024 字节。

## 自动清理

规则和数值见 README 的「自动清理」与 `src/config.js`，实现在 `src/evict.js`。

- `planEviction` 是纯函数：先按每人上限删各人最旧的，再按全站阈值删全站最旧的，长期文件一律跳过。改规则时先改它，再跑单元测试（见 `guides/deploy-and-test.md`）。
- `evict` 每删一个文件前都重读一次记录。list 拿到的是快照，期间文件可能被覆盖上传（换了资产 id）或者被设为长期，这两种情况都要跳过，否则会删掉新文件。
- 删除不清边缘缓存。下载先查 KV（不变量第 1 条），记录没了就 404，所以缓存里的旧内容不会再被返回。这样每删一个文件只花一个外部子请求，一次能删 40 个。
- 触发有两处：每小时的定时任务（`scheduled`），以及上传时 GitHub 返回 422。后者因为请求体已经读掉，没法在服务端重试，只能清理一批后返回 507，由客户端重传。
- 覆盖上传会保留长期标记，但 `created` 会更新成覆盖的时间，排队重新从最新开始。

用户名限 `[A-Za-z0-9_-]`，不含 `:`，所以 `file:ab:` 和 `file:ab_c:` 这两个前缀不会互相包含。路径编码后 `/` 变成 `%2F`，所以「目录 X 下的子项」就是前缀 `file:<用户>:<X 编码>%2F`（见 `dirHasChildren`）。

## 目录

目录分显式和隐式两种。

- **显式目录**：`dir:` 记录，由「新建文件夹」创建，可以是空的。
- **隐式目录**：文件路径上的各级父目录。前端在 `fetchEntries` 里推出来，没有 KV 记录。

删除目录只允许删空目录（既没有文件也没有子目录记录）。隐式目录在最后一个文件删掉后自然消失。

目前不支持重命名和移动。要做的话，改的是 KV 索引（删旧键、写新键），资产不用动；但这样每个文件要多一次写和一次删，会占免费额度。

## 身份模型

有两种凭据，校验时最终都回到 `user:<名>` 这条记录。

- **会话 cookie** `fb_session`：`base64url(JSON).base64url(HMAC-SHA256)`，载荷 `{u, r, v, exp}`，7 天，`HttpOnly; Secure; SameSite=Strict`，Path 取 `BASE_PATH`。签名密钥是 `SESSION_SECRET`，少于 32 字符时管理页直接报未配置。
- **API token**：`fb_` 加 48 位 hex（192 位随机）。KV 里只存 SHA-256，明文只在创建时返回一次。

每次请求都会重新读用户记录，检查 `disabled`，并比较账号版本：

- 改口令时 `ver` 加一，所有旧会话因为 `v` 对不上而失效；同时删掉这个账号的全部 token。
- token 记录里的 `v` 是创建时的 `ver`，作为第二道保险。
- 停用账号：会话和 token 立即失效（仍受 KV 最终一致的窗口影响）。
- 删除账号：连同名下文件（GitHub 资产和索引）、目录和 token 一起删。

角色只有 `admin` 和 `user` 两种：

- `user` 只能操作自己的文件、token 和口令。
- `admin` 额外能管理用户、给别人发 token，并且可以用 `?user=` 列出或删除别人的文件。但上传和建目录永远落在自己名下。
- 「不能停用或删除自己」加上「至少保留一个可用管理员」，保证不会把管理员全部锁在外面。

口令哈希用 PBKDF2-SHA256，迭代次数取 `PASSWORD_ITERATIONS`，并且写进每条用户记录。2026-11-14 线上实测，100000 次迭代的登录耗时约 0.8–0.9 秒，没有触发 CPU 限制（1102）。调整这个配置只影响以后新设的口令，已有账号仍按各自记录里的次数校验。用户不存在时也会用假盐算一遍哈希，避免靠响应时间判断账号是否存在。

## 上传数据流

1. 校验路径（`isPathSegments`）、扩展名、`keyFits`、`Content-Length`（必须有，且不超过 `MAX_FILE_BYTES`）。
2. 查同名：存在且没带 `overwrite=1`，返回 409。
3. 把请求体流式转发到 `uploads.github.com`，带上 `name`、`label` 和 `Content-Length`。
4. 写 `file:` 索引。
5. 覆盖上传时，删掉旧资产和旧缓存键。

第 3 步和第 4 步之间失败的话，会留下孤儿资产（见 `memory/doc-gaps.md`）。
