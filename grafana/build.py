#!/usr/bin/env python3
"""生成 grafana/dashboard.json：filebox 的 Grafana 面板，查 Analytics Engine 的 filebox_xfer。

  grafana/build.py           重新生成 dashboard.json
  grafana/build.py --check   只比对，dashboard.json 过期时以 1 退出
  grafana/build.py --test    把宏手工展开，逐条到 SQL API 上跑一遍（每条算一次查询）

--test 要环境变量 CLOUDFLARE_ACCOUNT_ID，令牌读 AE_TOKEN_FILE 指向的文件
（默认 ~/.config/cloudflare/filebox-analytics-token，权限只要 Account Analytics Read）。
列号的含义见 llmdoc/architecture/storage-and-auth.md 的「长期统计」。
"""
import json
import os
import subprocess
import sys
import time

TABLE = "filebox_xfer"
DS = {"type": "vertamedia-clickhouse-datasource", "uid": "${DS_AE}"}
DIR = "if(blob1 = 'up', '上传', '下载')"
OK = "double5 = 1"
BIG = f"{OK} AND double1 >= $min_mb * 1000000"
SPEED_NOTE = (
    "只算传完、且不小于 $min_mb MB 的传输。上传的耗时和客户端看到的一致；下载的耗时到字节交给 "
    "Cloudflare 运行时为止，之后还有 2–4 MB 的缓冲，所以小文件算出来偏快，缓存命中的小文件尤其明显。"
)


def target(query, fmt):
    return {
        "refId": "A",
        "datasource": DS,
        "format": fmt,
        "query": query,
        "editorMode": "sql",
        "database": "default",
        "table": TABLE,
        "dateTimeType": "DATETIME",
        "dateTimeColDataType": "timestamp",
        "dateColDataType": "",
        "interval": "",
        "intervalFactor": 1,
        "round": "0s",
        "extrapolate": False,
        "add_metadata": False,
        "skip_comments": True,
    }


def override(name, **props):
    return {
        "matcher": {"id": "byName", "options": name},
        "properties": [{"id": k, "value": v} for k, v in props.items()],
    }


# 列名 → 表头、单位、小数位。查询里的别名用英文，表头在这里换成中文。
COLS = {
    "dir": ("方向", None, None),
    "cache": ("缓存", None, None),
    "colo": ("节点", None, None),
    "user": ("用户", None, None),
    "file": ("文件", None, None),
    "error": ("错误", None, None),
    "time": ("时间", "dateTimeAsIso", None),
    "last": ("最近一次", "dateTimeAsIso", None),
    "transfers": ("次数", None, 0),
    "uploads": ("上传", None, 0),
    "downloads": ("下载", None, 0),
    "failed": ("中断", None, 0),
    "status": ("状态码", None, 0),
    "parts": ("段数", None, 0),
    "bytes": ("字节", "decbytes", None),
    "up_bytes": ("上传字节", "decbytes", None),
    "down_bytes": ("下载字节", "decbytes", None),
    "ms": ("耗时", "ms", 0),
    "wait_ms": ("等待", "ms", 0),
    "speed": ("速度", "MBs", 2),
    "p10": ("p10", "MBs", 2),
    "p50": ("p50", "MBs", 2),
    "p90": ("p90", "MBs", 2),
    "overall": ("总字节 / 总耗时", "MBs", 2),
}


def overrides(names, widths):
    out = []
    for n in names:
        title, unit, decimals = COLS[n]
        props = {"displayName": title}
        if n in widths:
            props["custom.width"] = widths[n]
        if unit:
            props["unit"] = unit
        if decimals is not None:
            props["decimals"] = decimals
        out.append(override(n, **props))
    return out


def aliases(query):
    """SELECT 列表里的别名，按顺序。"""
    head = query[len("SELECT "): query.index(" FROM ")]
    names, depth, cur = [], 0, ""
    for ch in head:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            names.append(cur.strip())
            cur = ""
        else:
            cur += ch
    names.append(cur.strip())
    return [n.rsplit(" AS ", 1)[-1] for n in names]


panels = []


def add(kind, title, grid, query=None, fmt="table", desc=None, **extra):
    p = {"id": len(panels) + 1, "type": kind, "title": title}
    x, y, w, h = grid
    if kind == "row":
        p.update({"collapsed": False, "gridPos": {"x": x, "y": y, "w": w, "h": h}, "panels": []})
        panels.append(p)
        return
    p["datasource"] = DS
    p["gridPos"] = {"x": x, "y": y, "w": w, "h": h}
    p["targets"] = [target(query, fmt)]
    names = [n for n in aliases(query) if n in COLS]
    widths = extra.pop("widths", {})
    p["fieldConfig"] = {"defaults": extra.pop("defaults", {}), "overrides": overrides(names, widths) if fmt == "table" else []}
    p["options"] = extra.pop("options", {})
    p.update(extra)
    if desc:
        p["description"] = desc
    panels.append(p)


BARS = {"min": 0, "custom": {"drawStyle": "bars", "fillOpacity": 70, "stacking": {"mode": "normal"}}}
LEGEND_BOTTOM = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}

add("row", "概览", (0, 0, 24, 1))
add(
    "timeseries", "传输次数", (0, 1, 9, 8),
    f"SELECT $timeSeries AS t, format('{{}}{{}}', {DIR}, if({OK}, '', '（中断）')) AS dir, sum(_sample_interval) AS transfers "
    f"FROM {TABLE} WHERE $timeFilter GROUP BY t, dir ORDER BY t",
    fmt="time_series", defaults={**BARS, "decimals": 0}, options=LEGEND_BOTTOM, interval="10m",
    desc="每个请求算一次：分段上传每段一次，带 Range 的下载每个请求一次。中断：客户端取消、断线，或者上游出错。",
)
add(
    "stat", "合计", (18, 1, 6, 8),
    f"SELECT sumIf(_sample_interval, blob1 = 'up' AND {OK}) AS uploads, sumIf(_sample_interval, blob1 = 'down' AND {OK}) AS downloads, "
    f"sumIf(double1 * _sample_interval, blob1 = 'up' AND {OK}) AS up_bytes, sumIf(double1 * _sample_interval, blob1 = 'down' AND {OK}) AS down_bytes, "
    f"sumIf(_sample_interval, double5 = 0) AS failed FROM {TABLE} WHERE $timeFilter",
    options={"reduceOptions": {"values": False, "calcs": ["lastNotNull"], "fields": "/.*/"}, "colorMode": "none", "graphMode": "none"},
    desc="上传、下载只数传完的，字节也只算传完的。",
)
add(
    "timeseries", "传输的字节", (9, 1, 9, 8),
    f"SELECT $timeSeries AS t, {DIR} AS dir, sum(double1 * _sample_interval) AS bytes FROM {TABLE} WHERE $timeFilter AND {OK} GROUP BY t, dir ORDER BY t",
    fmt="time_series", defaults={**BARS, "unit": "decbytes"}, options=LEGEND_BOTTOM, interval="10m",
    desc="只算传完的传输。",
)
add(
    "table", "各用户", (0, 9, 24, 6),
    f"SELECT blob2 AS user, sumIf(_sample_interval, blob1 = 'up' AND {OK}) AS uploads, sumIf(_sample_interval, blob1 = 'down' AND {OK}) AS downloads, "
    f"sumIf(double1 * _sample_interval, blob1 = 'up' AND {OK}) AS up_bytes, sumIf(double1 * _sample_interval, blob1 = 'down' AND {OK}) AS down_bytes, "
    f"sumIf(_sample_interval, double5 = 0) AS failed FROM {TABLE} WHERE $timeFilter GROUP BY user ORDER BY down_bytes DESC",
    desc="用户是文件的主人。下载不用登录，下载记在文件主人名下，不是下载的人。",
)

add("row", "速度", (0, 15, 24, 1))
add(
    "timeseries", "传输的平均速度（每 15 分钟）", (0, 16, 24, 8),
    f"SELECT (intDiv(toUInt32(timestamp), 900) * 900) * 1000 AS t, {DIR} AS dir, sum(double4 * _sample_interval) / sum(_sample_interval) AS speed "
    f"FROM {TABLE} WHERE $timeFilter AND {BIG} GROUP BY t, dir ORDER BY t",
    fmt="time_series",
    defaults={"unit": "MBs", "custom": {"drawStyle": "line", "showPoints": "always", "spanNulls": False}},
    options=LEGEND_BOTTOM,
    desc="每 15 分钟一个点：这 15 分钟里各次传输的速度的平均值，不随所选的时间范围变。没有合格传输的时间段没有点。" + SPEED_NOTE,
)
add(
    "table", "各方向的速度", (0, 24, 24, 6),
    f"SELECT {DIR} AS dir, blob4 AS cache, sum(_sample_interval) AS transfers, sum(double1 * _sample_interval) AS bytes, "
    "quantileExactWeighted(0.1)(double4, _sample_interval) AS p10, quantileExactWeighted(0.5)(double4, _sample_interval) AS p50, "
    "quantileExactWeighted(0.9)(double4, _sample_interval) AS p90, "
    "sum(double1 * _sample_interval) / 1000 / sum((double2 - double3) * _sample_interval) AS overall, "
    "sum(double3 * _sample_interval) / sum(_sample_interval) AS wait_ms "
    f"FROM {TABLE} WHERE $timeFilter AND {BIG} GROUP BY dir, cache ORDER BY transfers DESC",
    desc="缓存：HIT 是边缘缓存命中，不经过 GitHub；MISS 和 BYPASS 从 GitHub 取（分段的大文件都是 BYPASS）；上传没有这一项。"
    "等待：开始送出字节之前花的时间，速度里已经扣掉。" + SPEED_NOTE,
)
add(
    "table", "各节点的速度", (0, 30, 24, 7),
    f"SELECT blob5 AS colo, {DIR} AS dir, sum(_sample_interval) AS transfers, sum(double1 * _sample_interval) AS bytes, "
    "quantileExactWeighted(0.1)(double4, _sample_interval) AS p10, quantileExactWeighted(0.5)(double4, _sample_interval) AS p50, "
    "quantileExactWeighted(0.9)(double4, _sample_interval) AS p90 "
    f"FROM {TABLE} WHERE $timeFilter AND {BIG} GROUP BY colo, dir ORDER BY transfers DESC",
    desc="节点是接下这个请求的 Cloudflare 机房（三字码）。" + SPEED_NOTE,
)

add("row", "明细", (0, 37, 24, 1))
add(
    "table", "下载最多的文件", (0, 38, 24, 9),
    f"SELECT format('{{}}/{{}}', blob2, blob3) AS file, sum(_sample_interval) AS downloads, sumIf(_sample_interval, double5 = 0) AS failed, "
    f"sumIf(double1 * _sample_interval, {OK}) AS bytes, max(toUInt32(timestamp)) * 1000 AS last "
    f"FROM {TABLE} WHERE $timeFilter AND blob1 = 'down' GROUP BY file ORDER BY downloads DESC LIMIT 30",
    widths={"downloads": 90, "failed": 90, "bytes": 120, "last": 190},
    desc="次数按请求算，播放器和多线程下载器发的每个 Range 请求各算一次。HEAD 和 404 不在里面。",
)
add(
    "table", "最近的传输", (0, 47, 24, 12),
    f"SELECT toUInt32(timestamp) * 1000 AS time, {DIR} AS dir, format('{{}}/{{}}', blob2, blob3) AS file, blob4 AS cache, blob5 AS colo, double6 AS status, double7 AS parts, "
    f"double1 AS bytes, double2 AS ms, double3 AS wait_ms, double4 AS speed, blob6 AS error FROM {TABLE} WHERE $timeFilter ORDER BY time DESC LIMIT 100",
    widths={"time": 180, "dir": 60, "cache": 85, "colo": 60, "status": 75, "parts": 60, "bytes": 100, "ms": 90, "wait_ms": 85, "speed": 115, "error": 220},
    desc="有错误信息的是中断的传输：字节是本该传的长度，实际传了多少不知道，速度记 0。"
    "分段上传的文件名后面带 (n/of)；段数是这次下载拼接了几段，单文件为 0。",
)

dashboard = {
    "__inputs": [
        {
            "name": "DS_AE",
            "label": "Analytics Engine",
            "description": "指向 Analytics Engine SQL API 的 Altinity ClickHouse 数据源",
            "type": "datasource",
            "pluginId": "vertamedia-clickhouse-datasource",
            "pluginName": "Altinity plugin for ClickHouse",
        }
    ],
    "__requires": [
        {"type": "datasource", "id": "vertamedia-clickhouse-datasource", "name": "Altinity plugin for ClickHouse", "version": "3.0.0"}
    ],
    "uid": "filebox",
    "title": "filebox",
    "tags": ["cloudflare", "filebox"],
    "description": "filebox 的上传、下载次数和速度。数据来自 Workers Analytics Engine 的 filebox_xfer，列的含义见仓库 llmdoc/architecture/storage-and-auth.md 的「长期统计」。",
    "schemaVersion": 39,
    "version": 1,
    "editable": True,
    "graphTooltip": 1,
    "timezone": "browser",
    "time": {"from": "now-7d", "to": "now"},
    "refresh": "30m",
    "timepicker": {"refresh_intervals": ["15m", "30m", "1h"]},
    "templating": {
        "list": [
            {
                "name": "min_mb",
                "label": "速度只看不小于（MB）",
                "type": "textbox",
                "query": "20",
                "current": {"text": "20", "value": "20"},
                "options": [{"selected": True, "text": "20", "value": "20"}],
            }
        ]
    },
    "annotations": {"list": []},
    "links": [],
    "panels": panels,
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_sql(sql):
    """经 curl 查询。令牌走管道，不出现在命令行上。"""
    tok = open(os.environ.get("AE_TOKEN_FILE") or os.path.expanduser("~/.config/cloudflare/filebox-analytics-token")).read().strip()
    acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    r = subprocess.run(
        ["curl", "-sS", "--max-time", "60", "-w", "\n%{http_code}", "-H", "@-",
         f"https://api.cloudflare.com/client/v4/accounts/{acct}/analytics_engine/sql", "--data-binary", sql],
        input=f"Authorization: Bearer {tok}\n", capture_output=True, text=True,
    )
    body, _, code = r.stdout.rpartition("\n")
    return code, body


def expand(q, days=30, min_mb=0):
    now = int(time.time())
    q = q.replace("$timeFilter", f"timestamp >= toDateTime({now - days * 86400}) AND timestamp <= toDateTime({now})")
    q = q.replace("$timeSeries", "(intDiv(toUInt32(timestamp), 600) * 600) * 1000")
    return q.replace("$min_mb", str(min_mb))


if "--test" in sys.argv:
    bad = 0
    for p in panels:
        if p["type"] == "row":
            continue
        code, body = run_sql(expand(p["targets"][0]["query"]) + " FORMAT TabSeparated")
        rows = [l for l in body.splitlines() if l]
        print(f"--- {p['id']} {p['title']}: HTTP {code}, {len(rows)} 行")
        for l in rows[:4]:
            print("   ", l[:200])
        bad += code != "200"
    sys.exit(1 if bad else 0)

OUT = os.path.join(ROOT, "grafana", "dashboard.json")
text = json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n"
if "--check" in sys.argv:
    same = os.path.exists(OUT) and open(OUT).read() == text
    print("dashboard.json 是最新的" if same else "dashboard.json 过期了，重新跑 grafana/build.py")
    sys.exit(0 if same else 1)
with open(OUT, "w") as f:
    f.write(text)
print("写好 grafana/dashboard.json，查询", sum(p["type"] != "row" for p in panels), "条")
