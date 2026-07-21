# -*- coding: utf-8 -*-
# 生成内置样例净值数据：改用东方财富 pingzhongdata 接口抓取【真实完整历史单位净值】
# 数据源: https://fund.eastmoney.com/pingzhongdata/<code>.js  （变量 Data_netWorthTrend = [{x:ms, y:单位净值}, ...]）
# VIX 使用 CBOE 官方真实历史（build/tmp/vix.csv）。
import json, os, re, csv as _csv, subprocess, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "js", "sample-data.js")
TMP = os.path.join(HERE, "tmp")
os.makedirs(TMP, exist_ok=True)

START = datetime.date(2020, 1, 1)
END = datetime.date(2026, 7, 20)

# 全部为真实公募基金代码（东方财富）。510300 作为默认基准（沪深300）。
# (code, name, isBenchmark)
FUNDS = [
    ("510300", "华泰柏瑞沪深300ETF", True),
    ("110011", "易方达优质精选混合", False),
    ("161725", "招商中证白酒指数A", False),
    ("005827", "易方达蓝筹精选混合", False),
    ("110003", "易方达上证50增强A", False),
    ("519674", "银河创新成长混合", False),
    ("003096", "中欧医疗健康混合A", False),
    # 纳斯达克100：场内 ETF
    ("513100", "国泰纳斯达克100ETF", False),
    ("513300", "华夏纳斯达克100ETF", False),
    ("159941", "广发纳斯达克100ETF", False),
    # 纳斯达克100：场外 QDII
    ("270042", "广发纳斯达克100指数A", False),
    ("000834", "大成纳斯达克100", False),
    ("040046", "华安纳斯达克100人民币A", False),
]


def fetch_pingzhong(code):
    """下载 pingzhongdata 到本地并返回文本；已存在则复用。"""
    path = os.path.join(TMP, "pz_%s.js" % code)
    if not (os.path.exists(path) and os.path.getsize(path) > 10000):
        url = "https://fund.eastmoney.com/pingzhongdata/%s.js" % code
        subprocess.run(
            ["curl", "-s", "-m", "40",
             "-H", "Referer: https://fund.eastmoney.com/",
             "-H", "User-Agent: Mozilla/5.0",
             url, "-o", path],
            check=True,
        )
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def ms_to_date(ms):
    # 东方财富时间戳为北京时间当日 00:00 的 UTC 毫秒表示，需 +8h 还原交易日
    return (datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=ms, hours=8)).date()


def parse_navs(text):
    m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", text, re.S)
    if not m:
        return []
    arr = json.loads(m.group(1))
    out = []
    for it in arr:
        try:
            d = ms_to_date(it["x"])
            v = float(it["y"])
        except Exception:
            continue
        if START <= d <= END:
            out.append({"d": d.isoformat(), "v": round(v, 4)})
    out.sort(key=lambda x: x["d"])
    return out


def parse_real_name(text):
    m = re.search(r'fS_name\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else None


# ---------- 抓取全部基金真实净值 ----------
result = {}
for code, name, is_bench in FUNDS:
    txt = fetch_pingzhong(code)
    navs = parse_navs(txt)
    if not navs:
        raise SystemExit("!! %s 未解析到真实净值，请检查数据源" % code)
    real_name = parse_real_name(txt) or name
    result[code] = {"name": real_name, "isBenchmark": is_bench, "navs": navs}
    print("%s %-22s pts=%4d  %s(%s) -> %s(%s)"
          % (code, real_name, len(navs), navs[0]["d"], navs[0]["v"], navs[-1]["d"], navs[-1]["v"]))

# ---------- VIX 恐慌指数：CBOE 官方真实历史 ----------
def load_real_vix(path):
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        r = _csv.reader(fh)
        next(r, None)  # DATE,OPEN,HIGH,LOW,CLOSE
        for row in r:
            if len(row) < 5:
                continue
            ds, close = row[0].strip(), row[4].strip()
            if not ds or not close:
                continue
            try:
                mm, dd, yyyy = ds.split("/")
                iso = "%s-%s-%s" % (yyyy, mm, dd)
                v = float(close)
            except Exception:
                continue
            if START.isoformat() <= iso <= END.isoformat():
                out.append({"d": iso, "v": round(v, 2)})
    out.sort(key=lambda x: x["d"])
    return out


VIX_SRC = os.path.join(TMP, "vix.csv")
vix_arr = load_real_vix(VIX_SRC)
yr_v = collections.defaultdict(list)
for x in vix_arr:
    yr_v[x["d"][:4]].append(x["v"])
print("=== 真实 VIX 逐年均值 / 峰值 ===")
for y in sorted(yr_v):
    a = yr_v[y]
    print("  %s 均值%.1f 峰值%.1f 谷值%.1f" % (y, sum(a) / len(a), max(a), min(a)))
print("  真实 VIX 全期 点数%d 峰值%.1f" % (len(vix_arr), max(x["v"] for x in vix_arr)))

# ---------- 输出 ----------
meta = {
    "synthetic": False,
    "source": "东方财富 pingzhongdata（真实历史单位净值）",
    "note": "内置基金净值为东方财富公开接口抓取的【真实历史单位净值】，非合成。VIX 为 CBOE 官方真实历史。分红导致的单位净值除权未做复权处理，与基金页展示的单位净值一致。",
    "generatedAt": datetime.date.today().isoformat(),
    "range": [START.isoformat(), END.isoformat()],
    "funds": len(result),
}

with open(OUT, "w", encoding="utf-8") as f:
    f.write("// 内置基金净值数据（东方财富 pingzhongdata 抓取的真实历史单位净值）\n")
    f.write("// 字段: code -> { name, isBenchmark, navs:[{d:'YYYY-MM-DD', v:单位净值}] }\n")
    f.write("// VIX 恐慌指数(CBOE真实): window.SAMPLE_VIX -> [{d:'YYYY-MM-DD', v:数值}]\n")
    f.write("window.SAMPLE_META = " + json.dumps(meta, ensure_ascii=False) + ";\n")
    f.write("window.SAMPLE_FUNDS = ")
    json.dump(result, f, ensure_ascii=False)
    f.write(";\n")
    f.write("window.SAMPLE_VIX = ")
    json.dump(vix_arr, f, ensure_ascii=False)
    f.write(";\n")

print("DONE bytes-written ->", os.path.abspath(OUT))
