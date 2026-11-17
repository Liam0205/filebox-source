# Grafana 面板

`grafana/dashboard.json` 是一份 Grafana 面板，查 Analytics Engine 里的 `filebox_xfer`（列的含义见 `architecture/storage-and-auth.md` 的「长期统计」）。它由 `grafana/build.py` 生成，不要手改。安装步骤在 README 的「用 Grafana 看传输统计」。

## 数据源

面板用 Altinity 的 ClickHouse 插件（`vertamedia-clickhouse-datasource`）直接调 Analytics Engine 的 SQL API，中间没有别的服务。

- URL 是 `https://api.cloudflare.com/client/v4/accounts/<账户 id>/analytics_engine/sql`。
- 认证开关全部关掉，加一个自定义请求头 `Authorization: Bearer <令牌>`，打开 *Use POST method to send queries*。SQL API 只收 POST。
- 令牌只要 Account → Account Analytics → Read。这个权限能读账户下所有数据集。
- 面板里的数据源写成 `${DS_AE}`，导入时在下拉框里选。一个账户只要一个这样的数据源，已经有了就直接选它。

## 面板和查询

共 9 条查询，分三行。

| 面板 | 类型 | 内容 |
| - | - | - |
| 传输次数 | 柱状图 | 按方向、是否中断分开数，粒度跟着时间范围变（`$timeSeries`，最细 10 分钟） |
| 传输的字节 | 柱状图 | 同上，只算传完的 |
| 合计 | 数字 | 上传、下载的次数和字节，中断的次数 |
| 各用户 | 表 | 按 `blob2` 分组，内容同「合计」 |
| 传输的平均速度（每 15 分钟） | 折线 | 固定每 15 分钟一个点，这段时间里各次传输的 `MBps` 的平均值 |
| 各方向的速度 | 表 | 按方向和 `cache` 分组：次数、字节、p10 / p50 / p90、总字节除以总耗时、平均等待 |
| 各节点的速度 | 表 | 按 `colo` 和方向分组：次数、字节、p10 / p50 / p90 |
| 下载最多的文件 | 表 | 按 `用户/路径` 分组，取前 30 |
| 最近的传输 | 表 | 最近 100 条原始记录 |

三个速度面板只算传完的、不小于 `min_mb` MB 的传输。`min_mb` 是面板顶上的文本框变量，默认 20：下载的耗时只到字节交给运行时为止，之后还有 2–4 MB 的缓冲，小文件算出来的速度偏高（见 `architecture/storage-and-auth.md` 的「传输日志」）。

读数时要知道的：

- 次数按请求算。分段上传每段一次，带 Range 的下载每个请求一次，播放器和多线程下载器会把一个文件数成很多次。
- 「用户」是文件的主人。下载不用登录，记在文件主人名下。
- 中断的记录里，字节是本该传的长度，实际传了多少不知道，速度记 0。所以字节和速度都只统计 `double5 = 1` 的。
- 「总字节 / 总耗时」里的耗时扣掉了 `wait`，和 `MBps` 的算法一致。

## 写查询时的约束

Analytics Engine 的 SQL 是 ClickHouse 的子集，2026-11-17 试出来的：

- 没有 JOIN 和 UNION，`FROM` 后面的表不能起别名。`FROM (SELECT …)` 这样的子查询可以用，外层能按子查询的列过滤。
- 没有 `multiIf`、`CASE WHEN`、`concat`、`toString`。分支用 `if`（嵌套四层试过可以），拼字符串用 `format('{}/{}', a, b)`。
- 数字不能写成 `1e8` 这样的科学计数法，会报语法错误。
- `ORDER BY` 的列必须出现在 `SELECT` 里，否则报 `unable to find type of column`。
- 有的表达式列不写 `AS` 会报 `this column needs an explicit name`，面板里的列都写了别名。
- 计数用 `sum(_sample_interval)`，条件计数用 `sumIf`，分位数用 `quantileExactWeighted(q)(列, _sample_interval)`。
- 数据点写入后 1–2 分钟才查得到，同一时刻写的几条可能分几次出现。

Altinity 插件这一侧：

- 每个 target 都要带 `dateTimeType: "DATETIME"` 和 `dateTimeColDataType: "timestamp"`，否则 `$timeFilter`、`$timeSeries` 展开不了。
- `$timeSeries` 的粒度跟着时间范围和面板宽度变。要固定粒度就自己写，例如 15 分钟：`(intDiv(toUInt32(timestamp), 900) * 900) * 1000 AS t`。
- `time_series` 格式下，字符串列的值成为序列名。方向和「（中断）」后缀就是这样拼成图例的。
- 表格里的时间列取 `toUInt32(timestamp) * 1000`，单位设 `dateTimeAsIso`，按浏览器的时区显示。直接取 `timestamp` 显示的是 UTC 字符串。
- 查询里的列别名用英文，中文表头、单位、小数位、列宽都在 `build.py` 的 `COLS` 和各面板的 `widths` 里，用 `byName` 的 override 设置。
- 表格放在半宽的面板里，列一多就被截断，所以表格都占整行，窄的列给了固定宽度，剩下的宽度留给文件名。

## 查询额度

面板开着的时候，每次刷新发 9 次查询；页面关掉就不查。默认 30 分钟刷新，开一整天是 9 × 48 = 432 次。刷新间隔只留了 15 分钟、30 分钟、1 小时三档。

Analytics Engine 的查询额度按整个账户算（免费计划每天 1 万次），账户里别的面板、脚本的查询也算在里面，而且查询不受 Workers 请求上限的保护（见 `architecture/storage-and-auth.md` 的「长期统计」）。加面板、调刷新间隔之前先重新算一遍。

不要做的事：

- 不要在这个数据源上建告警规则。告警在后台全天定时查询，不开页面也在跑。
- 不要把别人邀请进 Grafana 当 Viewer。Viewer 能对数据源发任意查询，查得到所有用户的文件路径和账户下别的数据集。
- 这份面板不能用 Grafana 的对外分享链接：对外分享不支持变量，Altinity 的插件在分享页上也不发查询，页面全是 No data。

## 改面板

1. 改 `grafana/build.py`，跑一遍，它重写 `grafana/dashboard.json`。`--check` 只比对，过期时以 1 退出。
2. `CLOUDFLARE_ACCOUNT_ID=<账户 id> grafana/build.py --test` 把宏手工展开，每条查询到 SQL API 上跑一遍，打印状态码和前几行。令牌从 `AE_TOKEN_FILE` 指向的文件读，经管道交给 curl，不出现在命令行上。这一步花 9 次查询，`$min_mb` 按 0 展开。
3. 在 Grafana 里重新导入：Dashboards → New → Import，提示已存在时选 Import (Overwrite)。

在 Grafana 界面里手工改的东西不会回到仓库。

`--test` 只能说明 SQL 能跑，图画得对不对要在 Grafana 里看。2026-11-17 是在本机起一个 Grafana 看的：

- 下载 Grafana OSS 的 tar 包（13.3.1）和 Altinity 插件的 zip（3.5.0，`https://grafana.com/api/plugins/vertamedia-clickhouse-datasource/versions/3.5.0/download`），解到一个权限 700 的临时目录。
- `grafana.ini` 里 `http_addr = 127.0.0.1`、随机端口、随机的管理员口令，关掉注册和匿名访问。
- 数据源用 provisioning 的 yaml 建：`jsonData` 里 `httpHeaderName1: Authorization`、`usePOST: true`，`secureJsonData` 里 `httpHeaderValue1: Bearer $AE_TOKEN`，令牌只经环境变量传给 Grafana 进程。
- 面板经 `/api/dashboards/import` 导入，`inputs` 里给 `DS_AE` 填数据源的 uid。这条路径和界面上的 Import 一样会替换 `${DS_AE}`。
- 用 Playwright 登录后截图，同时数 `/api/ds/query` 的失败响应、页面上的 No data 和面板错误角标。
- 看完按 PID 停掉 Grafana 和它拉起的插件进程，删掉临时目录（解开后约 2 GB）。

## 没确认的

- 上传方向的面板没见过真实数据。2026-11-17 数据集里只有下载的记录，「上传」的序列、合计里的上传次数和字节都是 0。
- 在 Grafana Cloud 上导入后的样子。逐个面板看过的是本机的 Grafana 13.3.1 加 Altinity 3.5.0：9 条查询都有数据，数字和手工查出来的一致。
