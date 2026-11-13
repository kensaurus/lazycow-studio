"""Refresh shared/holidays-jp.json from the Cabinet Office's list of Japanese national holidays (内閣府「国民の祝日」).
The calendar on Posting marks these days. Run once a year (the office publishes the next year in February): npm run holidays"""
import csv, io, json, urllib.request
from pathlib import Path

SRC = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
raw = urllib.request.urlopen(urllib.request.Request(SRC, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read()
rows = list(csv.reader(io.StringIO(raw.decode("cp932"))))
days = {}
for r in rows[1:]:
    if len(r) >= 2 and r[0].count("/") == 2:
        y, m, d = (int(x) for x in r[0].split("/"))
        if y >= 2025:
            days[f"{y:04d}-{m:02d}-{d:02d}"] = r[1].strip()
out = Path(__file__).resolve().parent.parent / "shared" / "holidays-jp.json"
out.write_text(json.dumps({"source": SRC, "note": "Japanese national holidays. Refresh yearly: npm run holidays", "days": days}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(days)} holidays, {min(days)} to {max(days)}")
