# 存储与身份

## 分层

```
Worker ── KV（USERS 绑定）：用户、token、文件索引、目录
       └─ GitHub 私有仓库的 release：文件字节，一个文件一个资产，分段上传的大文件一段一个
```

GitHub release 只当字节仓库用。下载和删除都用资产 id 走仓库级接口（`/repos/{repo}/releases/assets/{id}`），跟具体是哪个 release 无关，所以换 release 不影响旧文件。只有定时任务的孤儿对账会列 release 的资产（`listAssets`），它只看 `RELEASE_TAG` 指向的那个 release。

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
| `file:<用户>:<encodeURIComponent(路径)>` | `{path, assetId, assetName?, parts?, size, type, created, keep?}` | 上传、设为长期 |
| `dir:<用户>:<encodeURIComponent(路径)>` | `{created}` | 新建目录 |

登录失败不写 KV。限流放在 zone 的速率限制规则里，见 `guides/deploy-and-test.md` 的「登录限流规则」一节。

文件键另带 metadata `{a: assetId, s: size, c: created, t: type, k?: 1, p?: [各段资产 id]}`，由 `putFile` 写入。KV list 会把 metadata 一起返回，所以列一个用户的文件、统计全站长期文件、挑最旧的文件，都只花一次 list，不用逐条 get。这一点有实际意义：每人最多 300 个文件，逐条 get 的话，刷新一次列表就是 300 次 KV 读。没有 metadata 的旧记录会回退到 get（`filesFromKeys`）。改文件记录的字段时，要同时改 `fileMeta` 和 `fromMeta`，metadata 上限 1024 字节。

分段文件的记录多一个 `parts: [{a, s}]`（各段的资产 id 和长度，按顺序），`assetId` 取第一段的 id。metadata 里只放 `p`（各段 id），22 段的 id 加起来两百多字节，放得下。列表和清理只需要知道一个文件占哪些资产，从 metadata 就能拿到；下载要知道每段多长，所以读完整记录。取一个文件的全部资产 id 统一用 `assetIdsOf`，它对单段文件返回 `[assetId]`。

## 自动清理

规则和数值见 README 的「自动清理」与 `src/config.js`，实现在 `src/evict.js`。

- 计数单位是资产（名额），一个文件的权重是它的段数。用户 2026-11-15 定的：大文件占几个资产就算几个名额，否则一个人传几个 2 GiB 的文件就能占掉 release 的大半。`maxKeepPerUser` 例外，按文件数算；`maxKeepTotal` 按名额算。
- `planEviction` 是纯函数：先按每人上限删各人最旧的，再按全站阈值删全站最旧的，长期文件一律跳过。改规则时先改它，再跑单元测试（见 `guides/deploy-and-test.md`）。
- `purgeFile` 删一个文件的顺序是：第一段资产、KV 记录、其余各段。第一段删不掉就抛出，什么都没变；后面的段删不掉只会留下孤儿，交给对账。
- `evict` 每删一个文件前都重读一次记录。list 拿到的是快照，期间文件可能被覆盖上传（换了资产 id）或者被设为长期，这两种情况都要跳过，否则会删掉新文件。
- 删除不清边缘缓存。下载先查 KV（不变量第 1 条），记录没了就 404，所以缓存里的旧内容不会再被返回。这样每删一个资产只花一个外部子请求，一次能删 40 个。一个 22 段的文件比这个批量还小，所以单个文件总能整个删掉，不会只删一半就停。
- 触发有两处：每小时的定时任务（`scheduled`），以及上传时 GitHub 返回 422。后者因为请求体已经读掉，没法在服务端重试，只能清理一批后返回 507，由客户端重传。
- 覆盖上传会保留长期标记，但 `created` 会更新成覆盖的时间，排队重新从最新开始。

用户名限 `[A-Za-z0-9_-]`，不含 `:`，所以 `file:ab:` 和 `file:ab_c:` 这两个前缀不会互相包含。路径编码后 `/` 变成 `%2F`，所以「目录 X 下的子项」就是前缀 `file:<用户>:<X 编码>%2F`（见 `dirHasChildren`）。

## 目录

目录分显式和隐式两种。

- **显式目录**：`dir:` 记录，由「新建文件夹」创建，可以是空的。
- **隐式目录**：文件路径上的各级父目录，没有 KV 记录。管理页在前端的 `fetchEntries` 里推出来；命令行的 `ls` 由服务端的 `listDir`（`src/names.js`）按同样的规则推出来，`/api/files?format=text` 用 `dir` 参数指定目录，只返回下一层，加 `recursive=1` 返回目录下的全部文件。

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

一次请求的上传（`/api/upload`）：

1. 校验路径（`isPathSegments`）、扩展名、`keyFits`、`Content-Length`（必须有，且不超过 `PART_BYTES`）。
2. 查同名：存在且没带 `overwrite=1`，返回 409。
3. 把请求体流式转发到 `uploads.github.com`，带上 `name`、`label` 和 `Content-Length`。
4. 写 `file:` 索引。
5. 覆盖上传时，删掉旧资产（分段文件的全部段）和旧缓存键。

第 3 步和第 4 步之间失败的话，会留下孤儿资产，由孤儿对账删掉。

## 重命名与移动

`/api/move?from=&to=` 只改索引，不动资产：写 `to` 的 `file:` 键，删 `from` 的键，再把资产的 `label` 改成新路径（分段文件每段一个 PATCH，label 是 `<新路径> (k/N)`）。下载地址的路径变了，`?v=` 不变，旧地址直接 404。`created` 保持不变，所以移动不会让文件在自动清理的排队里变新；长期标记跟着记录走。

- **先写新键再删旧键。** 中间失败时两个键指向同一组资产，字节还在，只是删掉其中一个会连带删掉另一个的字节。反过来先删再写，失败时资产就没有了索引，过 `ORPHAN_HOURS` 后会被对账删掉，等于丢了文件。
- **label 改不成不算失败**，只记日志。索引才是准的，label 只在重建索引时用。
- **`to` 落在目录上时移进去**：以 `/` 结尾，或者 `to` 有显式目录记录、或者下面有文件。判断隐式目录要用 `dirHasChildren`，会花两次 KV list，所以只在 `to` 不以 `/` 结尾、又没有显式记录时才查。
- 目标位置已有文件时返回 409，不做覆盖。覆盖要删掉目标的资产，还要决定长期标记跟谁，不值得为改名引进这些。
- 只能移动单个文件，不能移动目录：目录下有几百个文件时，一次请求的 KV 写和 GitHub 子请求都不够用。

## 分段上传与回执

免费版 Worker 的入口请求体上限是 100 MB，所以大于 `PART_BYTES` 的文件由客户端切段，一段一个请求（`/api/upload/part`），每段在 GitHub 上是一个独立资产，label 是 `<路径> (n/of)`。

传段的过程中不写 KV。每段传完，服务端返回一张回执：`{u, p, i, n, of, z, a, s, e}`，分别是用户、路径摘要（SHA-256 前 32 位 hex）、上传 id、段号、段数、文件总长、资产 id、段长、过期时间，用 `SESSION_SECRET` 做 HMAC 签名，签名前加了 `receipt:` 前缀，和会话 cookie 的签名区分开。客户端最后把全部回执交给 `/api/upload/complete`，服务端只靠验签和核对就能写索引，不需要中间状态。这样一次分段上传只写一次 KV，KV 每天 1,000 次的写额度不会被大文件吃掉。

`complete` 核对的内容：回执属于当前用户和这个路径；全部来自同一个上传 id、段数和总长一致；段号 1..of 各一张；各段长度加起来等于总长。同一组回执提交两次时，第二次直接返回已有的记录，否则覆盖逻辑会把刚写进索引的段当成旧资产删掉。

回执的有效期比孤儿判定时长短（`orphanTimes`，默认判定 6 小时、回执 5 小时）。顺序反过来的话，对账任务可能先删掉某一段，随后才有人拿着回执提交，索引里就会有一个缺段的文件。

## 分段下载

`serveParts`（`src/download.js`）按顺序向 GitHub 取各段，用 `FixedLengthStream` 接成一个响应流。每段花 2 个外部子请求（查资产、跟随签名跳转），所以段数上限 `MAX_PARTS` 是 22。Range 请求先用 `parseRange` 解析，再用 `partSlices` 换算到具体的段，只取用得到的那几段。

- 第一段在返回响应头之前就取好，取不到时还能返回 502；后面的段出错时只能中断流，客户端会收到一个比 `Content-Length` 短的响应。
- 分段文件不进边缘缓存（`x-cache: BYPASS`）。Cache API 单个对象最大 512 MB，而且整个文件写缓存要多花子请求。
- 拼接靠 `ctx.waitUntil` 保持运行。I/O 等待不计 CPU 时间，客户端连着就没有墙钟时间限制。
- 接流必须用 `FixedLengthStream` 这种运行时原生的流。`TransformStream` 是 JS 实现，每个数据块都要经过 JS。2026-11-15 线上实测，用 `TransformStream` 下载一个 200 MiB、3 段的文件，CPU 用到约 2 秒，传到 75–145 MB 时请求以 `exceededCpu` 结束；换成 `FixedLengthStream` 后，同一个文件完整下载只用了 8 ms CPU。`FixedLengthStream` 还让响应带上 `Content-Length`。用 `TransformStream` 时响应里没有这个头，流中途断掉，curl 也照样返回 0。
- 接近 2 GiB 的文件在线上的 CPU 用量还没测过（见 `memory/doc-gaps.md`）。

## 孤儿对账

`sweepOrphans`（`src/evict.js`）在每小时的定时任务里、清理之后运行，子请求预算是 48 减去清理用掉的。它列出 release 里全部资产（REST 分页，GraphQL 的 ReleaseAsset 没有数据库 id），挑出 `fb_` 开头、索引里没有、创建超过 `ORPHAN_HOURS` 的资产删掉。不是 `fb_` 开头的资产是别人手工放的，不碰。

对账不再单独 list 索引，用的是同一次定时任务里自动清理 list 出来的快照（`evict` 返回的 `files`），每小时省一次全量 KV list。这样做不会误删：快照里还留着刚被自动清理删掉的文件，它们的资产只会被当成已知，这次不删，没删干净的段等下一次对账；快照比列资产早几秒，这期间新传的资产创建时间不到 `ORPHAN_HOURS`，不会被判成孤儿。

对账删错了就是丢数据，所以保护比清理多：

- `SWEEP_ORPHANS` 默认关，线上配置打开，本地 `.dev.vars` 关掉（理由见 `must/invariants.md` 第 16 条）。
- `listAllFiles` 有键没能还原成记录时（`dropped`）不对账，那条记录引用的资产会被误判成孤儿。
- 一半以上的 `fb_` 资产都像孤儿时不删（`orphanDoubt`）。这通常说明 KV 和 release 对不上。
