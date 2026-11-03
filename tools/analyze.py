#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析「可搜索」法学期刊 PDF 的 pdftotext -raw 输出结构。
用法: python tools/analyze.py <raw.txt> [期刊名] [年份]
"""
import re, sys, json

def split_pages(text):
    # pdftotext 默认页间 \f
    return text.split("\f")

def issue_of(page):
    m = re.search(r"中国法学\s*2024\s*年第?\s*([0-9]+)\s*期", page)
    if m:
        return int(m.group(1))
    return None

def main():
    path = sys.argv[1]
    journal = sys.argv[2] if len(sys.argv) > 2 else "中国法学"
    year = sys.argv[3] if len(sys.argv) > 3 else "2024"
    text = open(path, encoding="utf-8").read()
    pages = split_pages(text)
    print(f"总页数: {len(pages)}")
    # 每页期号
    seq = []
    issue_pages = {}
    for i, p in enumerate(pages, 1):
        iss = issue_of(p)
        if iss is not None:
            seq.append((i, iss))
            issue_pages.setdefault(iss, []).append(i)
    print("各期页数:", {k: len(v) for k, v in sorted(issue_pages.items())})
    # 期号连续性（页序是否乱）
    issues_in_order = [iss for _, iss in seq]
    # 压缩相邻相同
    compressed = []
    for iss in issues_in_order:
        if not compressed or compressed[-1] != iss:
            compressed.append(iss)
    print("期号沿页序的切换序列(前60):", compressed[:60])
    # 是否整体有序
    ordered = compressed == sorted(compressed)
    print("页序是否按期有序(1→6 单调):", ordered)
    # 文章起点（内容提要）
    art_lines = []
    lines = text.split("\n")
    for idx, ln in enumerate(lines):
        if ln.startswith("内容提要") or ln.startswith("摘要 ") or ln.startswith("内容摘要"):
            art_lines.append(idx + 1)
    print("文章起点行数(内容提要):", len(art_lines))
    print("前 30 个文章起点行号:", art_lines[:30])
    # 每篇文章标题（内容提要往前找非空非页码行）
    titles = []
    for idx in art_lines:
        j = idx - 2  # lines 是 0-based, idx 是 1-based → 上一行 = idx-2
        # 往上找最近的非空行作为标题（可能跨行）
        cand = []
        k = idx - 2
        while k >= 0 and k >= idx - 4:
            t = lines[k].strip()
            if t and not re.fullmatch(r"[0-9]+", t) and not t.startswith("DOI"):
                cand.append(t)
            k -= 1
        titles.append("/".join(reversed(cand)))
    for i, t in enumerate(titles[:40], 1):
        print(f"  {i:2d}. {t[:60]}")

if __name__ == "__main__":
    main()
