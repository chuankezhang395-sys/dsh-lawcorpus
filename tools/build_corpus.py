#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从「可搜索」法学期刊 PDF 的 pdftotext -raw 输出重建题录层语料。

关键经验：
- 必须用 pdftotext -raw（-layout 因 ToUnicode CMap 损坏而乱码）。
- 页眉规律：标题页首行=页码；正文偶数页首行=文章标题、奇数页首行=「刊名 年份 年第 X 期」。
- 文章标题页 = 首行是纯数字页码 **且** 页首含「内容提要/内容摘要/编者按」。
  （另有「作者简介脚注+目次」溢出到第二页的延续页，首行也是页码但无摘要标记，须排除。）
- 目次块可能出现在标题页的顶部（目次在前）或底部（目次在后），须顺序无关解析。
- 页脚脚注在 -raw 下仍乱码，属全局现象，不影响题录层字段。

用法:
  python tools/build_corpus.py <raw.txt> <期刊名> <年份> [out.jsonl]
"""
import re, sys, json, hashlib, os, datetime

CJK = r"[\u4e00-\u9fff]"
PAGENO_RE = re.compile(r"^[0-9]{1,4}$")
DOT_PAGE_RE = re.compile(r"^·([0-9]{1,4})·$")
# 跨行页码：-raw 可能把「·101·」拆成「·101」+「·」两行
DOT_PAGE_OPEN_RE = re.compile(r"^·([0-9]{1,4})·?$")
DOI_RE = re.compile(r"^(DOI|D0I|DO1|D01|D01)[:：]")
ABS_MARK = re.compile(r"^(内容提要|内容摘要|摘\s*要|提\s*要)\s*[:：]?\s*")
KW_MARK = re.compile(r"^关\s*键\s*词")
EDITORIAL_MARK = re.compile(r"^编者按")
TOC_MARK = re.compile(r"^目\s*次\s*$")
OUTLINE_L1 = re.compile(r"^[一二三四五六七八九十]+、")
OUTLINE_L2 = re.compile(r"^[（(][一二三四五六七八九十]+[)）]")
OUTLINE_L3 = re.compile(r"^[0-9]{1,2}[\.、]")

def norm(text):
    return text.replace("\u3000", " ").strip()

def to_halfwidth(s):
    """全角字母/数字/标点 → 半角（U+FF01–U+FF5E 减 0xFEE0，全角空格→空格）。
    用于 -raw 下中文期刊竖排封面/页眉用全角数字（如「２０２６ 年第 １ 期」）时，
    让 issue_on_page / parse_cover 能匹配到。"""
    out = []
    for ch in s:
        cp = ord(ch)
        if cp == 0x3000:
            out.append(" ")
        elif 0xFF01 <= cp <= 0xFF5E:
            out.append(chr(cp - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)

def clean_run(s):
    """去掉 -raw 在中文间插入的零散空格（排版伪影）。"""
    return re.sub(r"\s+", "", s)

def is_garbled(text):
    """中文文本乱码判定。

    -raw 下 ToUnicode 损坏会产出「‰¨•¢„˜‡ı˘」式乱码：CJK 占比极低且含大量非 ASCII 非 CJK 的怪字符。
    但纯 ASCII 短行（页码、引号「"」、卷号「38,N」）与中文+拉丁混排（目录标题「从 CSR 到 ESG」）
    CJK 占比同样低却不该判乱码。故：短行(<6)不判；CJK 占比≥0.25 不判；低 CJK 时还须含 ≥3 个怪字符才判。
    """
    if not text:
        return False
    total = len(text)
    if total < 6:
        return False
    cjk = len(re.findall(CJK, text))
    if cjk / total >= 0.25:
        return False
    weird = len(re.findall(r"[^\x00-\x7f\u4e00-\u9fff]", text))
    return weird >= 3

def split_pages(text):
    return text.split("\f")

def page_lines(p):
    return [norm(l) for l in p.split("\n") if norm(l)]

def issue_on_page(page, journal, year):
    y = str(year)
    # 标准横排页眉：刊名 [》] 年份年第X期（zgfx/bjfyj/fxyj 三层全走这一条；
    # zwfx 竖排页眉拆散，期号改由 parse_cover 提供，不在此处理）。
    # 先全角→半角归一化：fxyj 部分期的页眉用全角数字「２０２６ 年第 １ 期」。
    page = to_halfwidth(page)
    m = re.search(re.escape(journal) + r"\s*[》】]?\s*" + y + r"\s*年第?\s*(\d+)\s*期", page)
    if m:
        return int(m.group(1))
    return None

def page_number_of(lines):
    for ln in lines[:8]:
        if PAGENO_RE.match(ln):
            return int(ln)
    for ln in lines[:8]:
        m = DOT_PAGE_RE.match(ln)
        if m:
            return int(m.group(1))
    # 跨行页码「·101」+「·」
    for i, ln in enumerate(lines[:8]):
        m = DOT_PAGE_OPEN_RE.match(ln)
        if m:
            return int(m.group(1))
    return None

def parse_cover(lines):
    """从竖排英文封面页提取 (期号, 起始页, 结束页)。

    zwfx 中外法学封面是逐字符竖排 -raw 下每行一字，join 去空格成
    「PekingUniversityLawJournalVol.36,No.3(2024)pp.746-763」；
    部分期用全角字母（Ｐｅｋｉｎｇ/Ｖｏｌ），故先 to_halfwidth 归一化。
    fxyj 法学研究封面「Chinese Journal of Law」偶有 ToUnicode 错字：
    「Vol.48,No.1」→「Vo48,V0.1」（N→V、o→0）、「Journal of Law」→「Journal ofLav」，
    期号正则须容错 No/N0/Vo/V0/Mo/M0，并以「逗号后」定位避免误吞卷号。
    """
    flat = to_halfwidth("".join(lines[:60])).replace(" ", "")
    if not re.search(r"Peking|University|[Vv][Oo0]|[Jj]ournal|[Cc]hinese", flat):
        return None, None, None
    issue = start = end = None
    # 期号：卷号后的逗号跟着 No./N0./V0./Mo. 形式（卷号如 Vo48 不能误当成期号）
    m = re.search(r"[,，]\s*(?:No|N0|Vo|V0|Mo|M0|N\s*o|V\s*o)[\.．]?\s*(\d)", flat)
    if m:
        issue = int(m.group(1))
    else:
        m = re.search(r"(?:No|N0|Vo|V0|Mo|M0)[\.．]?\s*(\d)", flat)
        if m:
            issue = int(m.group(1))
    m = re.search(r"[Pp][Pp][\.．]?\s*(\d+)\s*[-–—]\s*(\d+)", flat)
    if m:
        start = int(m.group(1))
        end = int(m.group(2))
    return issue, start, end

def _backfill_issues(records):
    """期号缺口回填：某整期的奇数页页眉在 -raw 下竖排乱码时，该期所有文章读不到期号。
    已知期号集合 K 连续（1..N 无中间缺口）时，缺期文章=下一期 N+1；
    K 在 [min,max] 内恰有一个缺口时，缺期文章=该缺口期。多期缺口则留 None（不可靠分配）。"""
    no_issue = [r for r in records if r.get("issue") is None and "error" not in r]
    if not no_issue:
        return
    known = sorted(set(r["issue"] for r in records if r.get("issue")))
    if not known:
        return
    lo, hi = known[0], known[-1]
    gaps = [i for i in range(lo, hi + 1) if i not in known]
    if gaps:
        if len(gaps) != 1:
            return
        fill = gaps[0]
    else:
        fill = hi + 1
    for r in no_issue:
        r["issue"] = fill

def is_title_page(lines):
    """标题页：页首含摘要/编者按标记，且含作者行或关键词标记（排除正文页）。"""
    if not lines:
        return False
    head = lines[:80]
    has_abs = any(ABS_MARK.match(l) for l in head)
    has_edt = any(EDITORIAL_MARK.match(l) for l in head)
    if not (has_abs or has_edt):
        return False
    has_author = any(is_author_line(l) for l in head)
    has_kw = any(KW_MARK.match(l) for l in head)
    return has_author or has_kw or has_edt

AUTHOR_TAIL = ("*", "＊", "∗")

def is_author_line(ln):
    return ln.endswith(AUTHOR_TAIL) and len(ln) <= 24 and not ln.startswith(AUTHOR_TAIL)

def collect_outline(lines, toc_idx):
    """从目次块抽大纲；标题数字与标题文本可能在相邻行，需合并。"""
    if toc_idx is None:
        return []
    outline = []
    j = toc_idx + 1
    n = len(lines)
    while j < n:
        ln = lines[j]
        if DOI_RE.match(ln) or ln.startswith(("Abstract", "D01", "D0I", "*", "＊")) \
           or ABS_MARK.match(ln) or KW_MARK.match(ln) or is_author_line(ln):
            break
        if OUTLINE_L2.match(ln) or OUTLINE_L1.match(ln) or OUTLINE_L3.match(ln):
            parts = [ln]
            j += 1
            while j < n and not (OUTLINE_L1.match(lines[j]) or OUTLINE_L2.match(lines[j]) or OUTLINE_L3.match(lines[j])):
                # 标题文本行结束信号：DOI / 脚注 / 摘要 / 关键词 / 页码 / 乱码行
                if DOI_RE.match(lines[j]) or lines[j].startswith(("*", "＊")) \
                   or ABS_MARK.match(lines[j]) or KW_MARK.match(lines[j]) \
                   or PAGENO_RE.match(lines[j]) or is_garbled(lines[j]):
                    break
                parts.append(lines[j])
                j += 1
            outline.append(clean_run("".join(parts)))
            continue
        j += 1
    return outline

def _is_title_break(ln):
    """标题向上收集时的结束信号。"""
    return (PAGENO_RE.match(ln) or DOT_PAGE_RE.match(ln) or DOT_PAGE_OPEN_RE.match(ln)
            or TOC_MARK.match(ln) or ABS_MARK.match(ln)
            or KW_MARK.match(ln) or EDITORIAL_MARK.match(ln)
            or ln.startswith(("*", "＊", "（", "("))
            or ln.endswith(("。", "；")) or len(ln) > 60
            or is_garbled(ln))

def parse_title_page(lines):
    """顺序无关地提取 title/authors/abstract/keywords/outline。"""
    n = len(lines)
    abs_idx = next((i for i, l in enumerate(lines) if ABS_MARK.match(l)), None)
    kw_idx = next((i for i, l in enumerate(lines) if KW_MARK.match(l)), None)
    toc_idx = next((i for i, l in enumerate(lines) if TOC_MARK.match(l)), None)
    edt_idx = next((i for i, l in enumerate(lines) if EDITORIAL_MARK.match(l)), None)
    author_idx = next((i for i, l in enumerate(lines) if is_author_line(l)), None)

    # 编者按/笔谈：标题=编者按之前的行；其余字段置空
    if edt_idx is not None:
        tp = []
        j = 1 if (lines and PAGENO_RE.match(lines[0])) else 0
        while j < edt_idx:
            if not _is_title_break(lines[j]):
                tp.append(lines[j])
            j += 1
        title = clean_run("".join(tp))
        return title, [], "", [], collect_outline(lines, toc_idx)

    # 作者：姓名可能拆行（「彭 / 岳*」），向上合并单字姓氏
    authors = []
    author_top = author_idx
    if author_idx is not None:
        a = lines[author_idx].rstrip("".join(AUTHOR_TAIL)).strip()
        if len(a) <= 2 and author_idx >= 1:
            prev = lines[author_idx - 1]
            if 1 <= len(prev) <= 2 and re.fullmatch(r"[\u4e00-\u9fff]+", prev):
                a = prev + a
                author_top = author_idx - 1
        # 姓名内部可能含全角空格（排版伪影），不能按空白切；只按 、，, 切多作者
        authors = [clean_run(x) for x in re.split(r"[,，、]", a) if clean_run(x)]

    # 标题：从作者行（或摘要行）向上，遇结束信号停
    title_parts = []
    anchor = author_top if author_idx is not None else abs_idx
    if anchor is not None:
        j = anchor - 1
        while j >= 0:
            ln = lines[j]
            if _is_title_break(ln):
                break
            title_parts.insert(0, ln)
            j -= 1
    title = clean_run("".join(title_parts))

    abstract = ""
    if abs_idx is not None:
        parts = [ABS_MARK.sub("", lines[abs_idx], count=1)]
        j = abs_idx + 1
        while j < n and not KW_MARK.match(lines[j]) and not TOC_MARK.match(lines[j]) \
              and not DOI_RE.match(lines[j]) and not lines[j].startswith(("*", "＊")):
            parts.append(lines[j])
            j += 1
        abstract = clean_run("".join(parts))

    keywords = []
    if kw_idx is not None:
        kline = KW_MARK.sub("", lines[kw_idx], count=1)
        kline = re.sub(r"^[:：]\s*", "", kline)
        inline_kw = [k for k in re.split(r"[；;，,、\s]+", kline) if k]
        keywords = inline_kw
        # bjfyj 关键词标记后换行（「关键词：」单独成行，真正的词在下一行起）
        if not inline_kw:
            j = kw_idx + 1
            while j < n:
                ln = lines[j]
                if (TOC_MARK.match(ln) or DOI_RE.match(ln) or ABS_MARK.match(ln)
                        or OUTLINE_L1.match(ln) or OUTLINE_L2.match(ln) or OUTLINE_L3.match(ln)
                        or ln.startswith(("*", "＊")) or is_garbled(ln)
                        or PAGENO_RE.match(ln) or DOT_PAGE_RE.match(ln)):
                    break
                ks = [k for k in re.split(r"[；;，,、\s]+", ln) if k]
                if not ks:
                    j += 1
                    continue
                keywords.extend(ks)
                j += 1

    outline = collect_outline(lines, toc_idx)
    return title, authors, abstract, keywords, outline

OPENING = "“《『「（([【〔〈"
CLOSING = "”》』」）)]】〕〉"

def _is_bare_heading(s):
    """标题数字独占一行（如「一、」「（一）」），标题文字在下一行。"""
    s = clean_run(s)
    return bool(re.fullmatch(r"[一二三四五六七八九十]+、", s)
                or re.fullmatch(r"[（(][一二三四五六七八九十]+[)）]", s))

def _looks_like_title_tail(s):
    """标题续行：无句读结尾、长度 3–25 字的名词性短语（如「的两种思路」「合同规范设计」）。"""
    if not s:
        return False
    if s[-1] in "。，、；：！？":
        return False
    if len(s) < 3 or len(s) > 25:
        return False
    return True

def _merge_title(lines, i):
    """从标题行 i 向下合并标题文字（引号/书名号拆行、bare 数字行）。

    规则：bare 数字行或开引号结尾必续；闭引号/闭书名号结尾且下一行是短短语时续一行；
    汉字结尾视为标题完整，停。返回 (合并后 key, 下一未消费行索引)。
    """
    n = len(lines)
    parts = [clean_run(lines[i])]
    j = i + 1
    while j < n and len(parts) <= 4:
        last = parts[-1]
        if (PAGENO_RE.match(lines[j]) or DOT_PAGE_RE.match(lines[j])
                or DOT_PAGE_OPEN_RE.match(lines[j]) or is_garbled(lines[j])
                or OUTLINE_L1.match(lines[j]) or OUTLINE_L2.match(lines[j])):
            break
        need = False
        if _is_bare_heading(last):
            need = True
        elif last and last[-1] in OPENING:
            need = True
        elif last and last[-1] in CLOSING:
            need = _looks_like_title_tail(clean_run(lines[j]))
        else:
            need = False
        if not need:
            break
        parts.append(clean_run(lines[j]))
        j += 1
    return "".join(parts), j

def outline_from_body(body_pages):
    """笔谈/编者按无目次块时，从正文页扫 L1/L2 标题做大纲。

    zwfx/bjfyj 正文标题「一、」独占一行、标题文字在下一行，且可能因引号/书名号
    被拆成多行（如「传统法律家长主义与《」+「民法典》」+「合同规范设计」）；
    fxyj 是「一、 问题的提出」同行。合并后若仍是纯标题数字（脚注枚举「一、二、
    三、」），丢弃。
    """
    seen = []
    out = []
    for p in body_pages:
        lines = page_lines(p)
        n = len(lines)
        i = 0
        while i < n:
            ln = lines[i]
            if OUTLINE_L1.match(ln) or OUTLINE_L2.match(ln):
                key, j = _merge_title(lines, i)
                # 纯标题数字（无任何文字）→ 脚注枚举或空标题，丢弃
                if _is_bare_heading(key):
                    i = j
                    continue
                # 以分号/逗号结尾 → 正文脚注引用法条（如「（一）告诉才处理的案件；」），
                # 非真标题，丢弃
                if key and key[-1] in "；;，,":
                    i = j
                    continue
                if key not in seen:
                    seen.append(key)
                    out.append(key)
                i = j
                continue
            i += 1
    return out

def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)
    raw_path, journal, year = args[0], args[1], args[2]
    out_path = args[3] if len(args) > 3 else "data/articles.jsonl"
    year = int(year)
    text = open(raw_path, encoding="utf-8").read()
    pages = split_pages(text)

    plines = [page_lines(p) for p in pages]
    iss_page = [issue_on_page(p, journal, year) for p in pages]

    title_idx = [i for i, ls in enumerate(plines) if ls and is_title_page(ls)]

    records = []
    n = len(title_idx)
    for k, sp in enumerate(title_idx):
        ep = title_idx[k + 1] if k + 1 < n else len(pages)
        tls = plines[sp]
        title, authors, abstract, keywords, outline = parse_title_page(tls)
        if not title:
            records.append({"error": "no_title", "startPage": page_number_of(tls)})
            continue
        # 期号：文章页内多数投票；zwfx 竖排封面直接给期号更可靠
        votes = [iss_page[i] for i in range(sp, ep) if iss_page[i]]
        issue = max(set(votes), key=votes.count) if votes else None
        cov_issue, cov_start, cov_end = parse_cover(tls)
        if cov_issue is not None:
            issue = cov_issue
        start_page = page_number_of(tls)
        if start_page is None and cov_start is not None:
            start_page = cov_start
        end_page = cov_end
        if end_page is None:
            for i in range(ep - 1, sp - 1, -1):
                end_page = page_number_of(plines[i])
                if end_page is not None:
                    break
        # 大纲：标题页无目次时，从文章其它页找目次块，再退正文扫标题
        if not outline:
            for pi in range(sp + 1, ep):
                t2 = next((j for j, l in enumerate(plines[pi]) if TOC_MARK.match(l)), None)
                if t2 is not None:
                    outline = collect_outline(plines[pi], t2)
                    if outline:
                        break
        if not outline and ep - sp > 1:
            outline = outline_from_body(pages[sp + 1:ep])
        is_editorial = (not abstract) and (not keywords)
        title_key = clean_run(title)
        rec = {
            "id": hashlib.sha1((title_key + "|" + str(year)).encode("utf-8")).hexdigest()[:12],
            "journal": journal,
            "year": year,
            "issue": issue,
            "column": None,
            "title": title,
            "authors": authors,
            "abstract": abstract,
            "keywords": keywords,
            "pages": f"{start_page}-{end_page}" if start_page is not None and end_page is not None else None,
            "startPage": start_page,
            "discipline": None,
            "outline": outline,
            "outlineCount": len(outline),
            "type": "editorial" if is_editorial else "article",
            "source": f"pdf:{os.path.basename(raw_path)}",
            "quality": {"abstractGarbled": is_garbled(abstract)},
            "extractedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        records.append(rec)

    # —— 期号缺口回填：某整期的奇数页页眉在 -raw 下竖排乱码时，该期文章读不到期号 ——
    _backfill_issues(records)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    std = [r for r in records if r.get("type") == "article"]
    edt = [r for r in records if r.get("type") == "editorial"]
    err = [r for r in records if "error" in r]
    garbled = [r for r in records if r.get("quality", {}).get("abstractGarbled")]
    no_issue = [r for r in records if r.get("issue") is None and "error" not in r]
    with_outline = [r for r in std if r.get("outlineCount", 0) > 0]
    with_abs = [r for r in std if r.get("abstract")]
    with_kw = [r for r in std if r.get("keywords")]
    issues = sorted(set(r["issue"] for r in records if r.get("issue")))
    report = {
        "raw": raw_path,
        "pages": len(pages),
        "titlePages": len(title_idx),
        "records": len(records),
        "standard": len(std),
        "editorial": len(edt),
        "error": len(err),
        "garbledAbstract": len(garbled),
        "noIssue": len(no_issue),
        "issues": issues,
        "coverage": {
            "abstract": f"{len(with_abs)}/{len(std)}",
            "keywords": f"{len(with_kw)}/{len(std)}",
            "outline": f"{len(with_outline)}/{len(std)}",
        },
    }
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
