#!/usr/bin/env python
# 汇总 corpus/articles_*.jsonl 的质量报告
import json, glob, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
corpus = os.path.join(root, "data")
files = sorted(glob.glob(os.path.join(corpus, "articles_*.jsonl")))

print("=" * 70)
print("法学期刊论文框架语料库 — 全量质量报告")
print("=" * 70)

total_std = 0
total_edt = 0
total_err = 0
total_garbled = 0
total_noissue = 0
rows = []
for fp in files:
    key = os.path.basename(fp).replace("articles_", "").replace(".jsonl", "")
    recs = [json.loads(l) for l in open(fp, encoding="utf-8")]
    std = [r for r in recs if r.get("type") == "article"]
    edt = [r for r in recs if r.get("type") == "editorial"]
    err = [r for r in recs if "error" in r]
    garbled = [r for r in recs if r.get("quality", {}).get("abstractGarbled")]
    noissue = [r for r in recs if r.get("issue") is None and "error" not in r]
    noabs = [r for r in std if not r.get("abstract")]
    nokw = [r for r in std if not r.get("keywords")]
    noout = [r for r in std if not r.get("outlineCount")]
    total_std += len(std); total_edt += len(edt); total_err += len(err)
    total_garbled += len(garbled); total_noissue += len(noissue)
    rows.append((key, len(std), len(edt), len(err), len(garbled), len(noissue),
                 len(noabs), len(nokw), len(noout)))

header = f"{'key':<12}{'标准':>5}{'笔谈':>5}{'错误':>5}{'乱码':>5}{'缺期':>5}{'缺摘要':>6}{'缺关键词':>7}{'缺目录':>6}"
print(header)
print("-" * len(header))
for r in rows:
    print(f"{r[0]:<12}{r[1]:>5}{r[2]:>5}{r[3]:>5}{r[4]:>5}{r[5]:>5}{r[6]:>6}{r[7]:>7}{r[8]:>6}")
print("-" * len(header))
print(f"{'合计':<12}{total_std:>5}{total_edt:>5}{total_err:>5}{total_garbled:>5}{total_noissue:>5}")

# 作者姓名异常检测：单字作者（疑似拆行漏网）
bad_author = []
for fp in files:
    key = os.path.basename(fp)
    recs = [json.loads(l) for l in open(fp, encoding="utf-8")]
    for r in recs:
        if r.get("type") == "article":
            for a in r.get("authors", []):
                if len(a) == 1:
                    bad_author.append((key, r["title"][:30], a))
print()
print(f"单字作者（疑似拆行漏网）: {len(bad_author)}")
for k, t, a in bad_author[:20]:
    print(f"  {k}  {a}  {t}")
