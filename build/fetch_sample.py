import urllib.request, json, time, os

HEADERS = {
    "Referer": "https://fundf10.eastmoney.com/",
    "User-Agent": "Mozilla/5.0"
}
# (基金代码, 名称, 是否作为基准)
FUNDS = [
    ("110011", "易方达优质精选混合", False),
    ("161725", "招商中证白酒指数", False),
    ("005827", "易方达蓝筹精选混合", False),
    ("110003", "易方达上证50增强", False),
    ("519674", "银河创新成长混合", False),
    ("003096", "中欧医疗健康混合A", False),
    ("510300", "华泰柏瑞沪深300ETF", True),   # 作为基准
]
START = "2020-01-01"
END = "2026-07-15"
OUT_DIR = r"C:\Users\devilts\WorkBuddy\2026-07-21-14-29-18\fund-simulator\js"
os.makedirs(OUT_DIR, exist_ok=True)


def fetch_fund(code):
    # 先取总数
    url = ("https://api.fund.eastmoney.com/f10/lsjz?fundCode=%s"
           "&pageIndex=1&pageSize=1&startDate=%s&endDate=%s" % (code, START, END))
    req = urllib.request.Request(url, headers=HEADERS)
    data = json.load(urllib.request.urlopen(req, timeout=20))
    total = (data.get("Data") or {}).get("TotalCount", 0)
    pages = max(1, (total + 99) // 100)
    rows = []
    for p in range(1, pages + 1):
        url = ("https://api.fund.eastmoney.com/f10/lsjz?fundCode=%s"
               "&pageIndex=%d&pageSize=100&startDate=%s&endDate=%s"
               % (code, p, START, END))
        req = urllib.request.Request(url, headers=HEADERS)
        d = json.load(urllib.request.urlopen(req, timeout=20))
        lst = (d.get("Data") or {}).get("LSJZList") or []
        for it in lst:
            date = it.get("FSRQ")
            nav = it.get("DWJZ")
            if date and nav not in (None, "", "--"):
                try:
                    rows.append((date, float(nav)))
                except ValueError:
                    pass
        time.sleep(0.15)
    rows.sort(key=lambda x: x[0])
    return rows


result = {}
for code, name, is_bench in FUNDS:
    try:
        rows = fetch_fund(code)
        result[code] = {
            "name": name,
            "isBenchmark": is_bench,
            "navs": [{"d": d, "v": v} for d, v in rows],
        }
        print("%s %s points=%d range=%s..%s"
              % (code, name, len(rows), rows[0][0], rows[-1][0]))
    except Exception as e:
        print("ERR", code, name, e)

with open(os.path.join(OUT_DIR, "sample-data.js"), "w", encoding="utf-8") as f:
    f.write("// 内置样例基金净值数据（来源：东方财富基金历史净值接口，构建时抓取）\n")
    f.write("// 字段: code -> { name, isBenchmark, navs:[{d:'YYYY-MM-DD', v:单位净值}] }\n")
    f.write("window.SAMPLE_FUNDS = ")
    json.dump(result, f, ensure_ascii=False)
    f.write(";\n")

print("DONE. funds=", len(result))
