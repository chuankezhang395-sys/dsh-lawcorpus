#!/usr/bin/env python3
"""离线法学题录检索。Python 3.10+，仅标准库，不改写语料。"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys
import unicodedata
from collections import Counter

ROOT = Path(__file__).resolve().parents[4]
FIELDS = {'title': 3, 'keywords': 4, 'abstract': 1, 'outline': 1}
LIMITATIONS = [
    '仅检索本地题录，不含全文；未命中不等于该领域没有研究。',
    '来源为仓库现有 PDF 抽取记录，本仓库未附原始 PDF，未逐篇核实出版真实性及抽取准确性。',
    '原说明记载：中外法学2024缺1、2、5期；2026并非全年完整；少数期号经规则回填。',
    '体裁和摘要功能为规则判断；词元覆盖率不是语义相似概率、创新性评分或录用概率。',
]
GENRES = {
    '实证研究': ['实证', '样本', '回归', '问卷', '裁判文书', '统计分析'],
    '比较法': ['比较法', '域外', '德国', '日本', '美国', '欧盟'],
    '案例评析': ['案例评析', '指导性案例', '个案', '判例'],
    '教义学': ['教义学', '构成要件', '请求权基础', '解释论', '体系解释', '规范构造'],
    '立法论': ['立法建议', '立法论', '修法', '制度构建', '草案'],
    '理论建构': ['理论建构', '范式', '重构', '正当性', '反思'],
}


def normalized(value):
    return unicodedata.normalize('NFKC', value).lower()


def tokens(value):
    out = []
    for run in re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9][a-z0-9._-]*', normalized(value)):
        if re.match(r'[\u3400-\u9fff]', run):
            out.extend(run[i:i+2] for i in range(len(run)-1))
        elif len(run) >= 2:
            out.append(run)
    return out


def field_text(article, field):
    value = article.get(field)
    return ' '.join(value) if isinstance(value, list) else value or ''


def genre(article):
    scores = {g: sum(2 * field_text(article, 'title').count(w) + field_text(article, 'abstract').count(w)
                     for w in words) for g, words in GENRES.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else '一般论述'


def title_pattern(title):
    for pattern, label in [(r'[—–]', '主副标题'), (r'[:：]', '冒号限定'),
                           (r'^(也论|再论|论)', '论题式'), (r'何以|如何|是否|[?？]', '设问式'),
                           (r'比较|域外', '比较式'), (r'制度|规则|机制', '制度规则式')]:
        if re.search(pattern, title):
            return label
    return '其他陈述式'


class Corpus:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.files = sorted(self.directory.glob('*.jsonl'))
        if not self.files:
            raise ValueError(f'未找到 JSONL 语料：{self.directory}')
        self.articles = []
        self.locations = {}
        self.hashes = {}
        ids = set()
        for file in self.files:
            self.hashes[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
            for number, line in enumerate(file.read_text(encoding='utf-8').splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    a = json.loads(line)
                    valid = (isinstance(a, dict) and all(isinstance(a.get(k), str) and a[k]
                             for k in ['id', 'title', 'journal']) and type(a.get('year')) is int
                             and (a.get('abstract') is None or isinstance(a.get('abstract'), str))
                             and all(a.get(k) is None or (isinstance(a[k], list) and
                                     all(isinstance(v, str) for v in a[k]))
                                     for k in ['authors', 'keywords', 'outline']))
                    if not valid:
                        raise ValueError('题录字段缺失或类型不符')
                    if a['id'] in ids:
                        raise ValueError(f"重复 ID：{a['id']}，为避免覆盖原记录已停止")
                except (ValueError, TypeError) as exc:
                    raise ValueError(f'{file.name}:{number}: {exc}') from exc
                ids.add(a['id'])
                self.articles.append(a)
                self.locations[a['id']] = {'file': str(file), 'line': number}
        if not self.articles:
            raise ValueError('语料文件没有有效题录')
        self.counters = [{f: Counter(tokens(field_text(a, f))) for f in FIELDS} for a in self.articles]
        self.df = {f: Counter(t for c in self.counters for t in c[f]) for f in FIELDS}
        self.avg = {f: statistics.mean(sum(c[f].values()) for c in self.counters) or 1 for f in FIELDS}

    def select(self, args):
        return [a for a in self.articles if
                (not args.journal or normalized(a['journal']) == normalized(args.journal.strip('《》'))) and
                (args.year_from is None or a['year'] >= args.year_from) and
                (args.year_to is None or a['year'] <= args.year_to) and
                (args.type == 'all' or a.get('type') == args.type) and
                (not args.genre or genre(a) == args.genre)]

    def record(self, a):
        return {'article': a, 'location': self.locations[a['id']]}

    def search(self, query, selected, mode='ranked', min_coverage=0):
        qt = Counter(tokens(query))
        if not qt:
            raise ValueError('请输入至少两个连续汉字或两个英文字母/数字；不支持孤立单字检索')
        allowed = {a['id'] for a in selected}
        rows = []
        for a, counters in zip(self.articles, self.counters):
            if a['id'] not in allowed:
                continue
            text = '\n'.join(field_text(a, f) for f in FIELDS)
            exact_fields = [f for f in FIELDS if normalized(query.strip()) in normalized(field_text(a, f))]
            if mode == 'phrase' and not exact_fields:
                continue
            if mode == 'all' and not all(normalized(part) in normalized(text) for part in query.split()):
                continue
            matched = set(qt) & set().union(*(set(c) for c in counters.values()))
            coverage = len(matched) / len(qt)
            if not matched or coverage < min_coverage:
                continue
            score = 0
            for f, weight in FIELDS.items():
                length = sum(counters[f].values())
                for t in matched:
                    tf = counters[f][t]
                    df = self.df[f][t]
                    idf = math.log(1 + (len(self.articles) - df + .5) / (df + .5))
                    score += weight * idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * length / self.avg[f])) * min(qt[t], 3)
            row = self.record(a)
            row.update(score=round(score, 4), coverage=round(coverage, 4), matched_tokens=sorted(matched),
                       exact_phrase_fields=exact_fields, snippets={f: field_text(a, f) for f in FIELDS
                       if set(tokens(field_text(a, f))) & matched})
            rows.append(row)
        return sorted(rows, key=lambda r: (-r['score'], r['article']['id']))


def counts(values):
    return dict(Counter(values).most_common())


def status(corpus, selected):
    papers = [a for a in selected if a.get('type') == 'article']
    return {'total': len(selected), 'types': counts(a.get('type', 'unknown') for a in selected),
            'by_journal': counts(a['journal'] for a in selected), 'by_year': counts(a['year'] for a in selected),
            'matrix': {j: counts(a['year'] for a in selected if a['journal'] == j)
                       for j in sorted({a['journal'] for a in selected})},
            'paper_count': len(papers), 'completeness': {f: {'present': sum(bool(a.get(f)) for a in papers),
            'denominator': len(papers)} for f in ['abstract', 'keywords', 'outline']},
            'suspect_short_titles': [corpus.record(a) for a in selected if len(a['title']) < 8],
            'file_sha256': corpus.hashes,
            'note': '字段非空不代表内容准确；短题名仅为复核线索，不自动修改。哈希涵盖全部输入文件。'}


def profile(corpus, selected):
    return {'count': len(selected), 'by_journal': counts(a['journal'] for a in selected),
            'by_year': counts(a['year'] for a in selected),
            'genres_rule_based': counts(genre(a) for a in selected),
            'title_patterns_rule_based': counts(title_pattern(a['title']) for a in selected),
            'median_abstract_chars': statistics.median(len(a.get('abstract') or '') for a in selected) if selected else None,
            'median_outline_items': statistics.median(len(a.get('outline') or []) for a in selected) if selected else None,
            'top_keywords': Counter(k for a in selected for k in a.get('keywords') or []).most_common(20),
            'examples': [corpus.record(a) for a in selected[:3]]}


def frame(row):
    a = row['article']
    sentences = [s for s in re.split(r'(?<=[。！？；])', a.get('abstract') or '') if s.strip()]
    slots = {}
    for role, pattern in {'问题': '问题|争议|困境|不足', '方法': '通过|考察|比较|分析|解释',
                          '结论': '应当|因此|认为|必须|由此|需要'}.items():
        slots[role] = next((s for s in sentences if re.search(pattern, s)), None)
    return {**row, 'frame': {'genre_rule_based': genre(a), 'title_pattern_rule_based': title_pattern(a['title']),
                             'outline_original': a.get('outline'), 'abstract_slots_original_rule_based': slots,
                             'note': '槽位仅按词表选取摘要原句；无法识别时为null，不补写论文观点。'}}


def match_report(corpus, selected, args):
    query = ' '.join(filter(None, [args.title, args.abstract, args.keywords]))
    rows = corpus.search(query, selected, args.mode, args.min_coverage)
    keyword_set = set(filter(None, re.split(r'[，,；;、\s]+', args.keywords or '')))
    own_len = len(args.abstract or '')
    results = []
    for row in rows[:args.limit]:
        a = row['article']
        results.append({**frame(row), 'comparison': {
            'query_token_coverage_percent': round(row['coverage'] * 100, 2),
            'your_abstract_chars': own_len, 'reference_abstract_chars': len(a.get('abstract') or ''),
            'abstract_chars_difference': own_len - len(a.get('abstract') or '') if args.abstract else None,
            'shared_keywords_exact': sorted(keyword_set & set(a.get('keywords') or [])),
            'reference_keywords_not_in_your_list': sorted(set(a.get('keywords') or []) - keyword_set),
            'note': '长度差、关键词差只供人工检查，不能据此判断论文质量或研究空白。'}})
    return {'matched_total': len(rows), 'results': results}


def export_records(corpus, articles, output, fmt, overwrite=False):
    # 导出仅写当前工作目录的 output/，同时保护原始语料与程序。
    base = Path.cwd().resolve() / 'output'
    target = Path(output)
    if not target.is_absolute():
        target = Path.cwd() / target
    resolved = target.resolve()
    if target.is_symlink() or not resolved.is_relative_to(base) or resolved == base:
        raise ValueError('导出路径必须位于当前工作目录的 output/ 内，不能通过符号链接写到外部')
    if any(resolved == f.resolve() for f in corpus.files) or resolved.is_relative_to(corpus.directory):
        raise ValueError('禁止覆盖原始语料')
    target.parent.mkdir(parents=True, exist_ok=True)
    if fmt == 'jsonl':
        content = ''.join(json.dumps(a, ensure_ascii=False) + '\n' for a in articles)
    elif fmt == 'csv':
        buf = io.StringIO(newline='')
        fields = ['id', 'journal', 'year', 'issue', 'title', 'authors', 'abstract', 'keywords', 'outline', 'pages', 'source', 'corpus_file', 'corpus_line']
        writer = csv.DictWriter(buf, fieldnames=fields)
        writer.writeheader()
        for a in articles:
            row = {k: a.get(k) for k in fields[:-2]}
            row.update(corpus_file=corpus.locations[a['id']]['file'], corpus_line=corpus.locations[a['id']]['line'])
            for k, v in row.items():
                if isinstance(v, (list, dict)):
                    row[k] = json.dumps(v, ensure_ascii=False)
                # 防止电子表格将题录文字作为公式执行；JSONL保留无改动原记录。
                elif isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')):
                    row[k] = "'" + v
            writer.writerow(row)
        content = '\ufeff' + buf.getvalue()
    else:
        content = '# 法学题录导出\n\n' + '\n'.join(LIMITATIONS) + '\n\n'
        for a in articles:
            loc = corpus.locations[a['id']]
            content += f"## {a['title']}\n\n"
            content += f"作者：{'、'.join(a.get('authors') or [])}；期刊：{a['journal']}；年：{a['year']}；期：{a.get('issue')}；页码：{a.get('pages')}\n\n"
            content += f"ID：{a['id']}；来源：{a.get('source')}；题录位置：{loc['file']}:{loc['line']}\n\n"
            content += f"关键词：{'；'.join(a.get('keywords') or [])}\n\n摘要原文：{a.get('abstract') or '（缺失）'}\n\n目录原文：\n\n"
            content += '\n'.join('- ' + x for x in a.get('outline') or []) + '\n\n'
    with target.open('w' if overwrite else 'x', encoding='utf-8', newline='') as stream:
        stream.write(content)
    return {'file': str(target.resolve()), 'count': len(articles), 'format': fmt}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-dir', default=os.environ.get('LAWCORPUS_DIR', str(ROOT / 'data')), help='语料目录；默认仓库data，可设LAWCORPUS_DIR')
    commands = p.add_subparsers(dest='command', required=True)
    for name in ['status', 'search', 'profile', 'frame', 'match', 'export']:
        sub = commands.add_parser(name)
        sub.add_argument('--journal', help='期刊全名，可带书名号')
        sub.add_argument('--year-from', type=int)
        sub.add_argument('--year-to', type=int)
        sub.add_argument('--type', choices=['all', 'article', 'editorial'], default='all' if name in ['status', 'export'] else 'article')
        sub.add_argument('--genre', choices=list(GENRES) + ['一般论述'])
        sub.add_argument('--query', help='中文主题；不自动扩展近义词')
        sub.add_argument('--mode', choices=['ranked', 'phrase', 'all'], default='ranked', help='ranked词元排序；phrase完整短语；all空格分隔词全部出现')
        sub.add_argument('--min-coverage', type=float, default=0, help='最低词元覆盖率0到1')
        sub.add_argument('--limit', type=int, default=5)
        if name == 'match':
            sub.add_argument('--title', default='')
            sub.add_argument('--abstract', default='')
            sub.add_argument('--keywords', default='')
        if name == 'export':
            sub.add_argument('--format', choices=['jsonl', 'csv', 'markdown'], default='markdown')
            sub.add_argument('--output', required=True, help='例如output/检索结果.md；仅允许output/目录')
            sub.add_argument('--overwrite', action='store_true')
    return p


def run(args):
    if args.year_from is not None and args.year_to is not None and args.year_from > args.year_to:
        raise ValueError('起始年份不能晚于结束年份')
    if not 0 <= args.min_coverage <= 1 or not 1 <= args.limit <= 100:
        raise ValueError('min-coverage须为0到1，limit须为1到100')
    corpus = Corpus(args.data_dir)
    selected = corpus.select(args)
    if args.command in ['search', 'frame'] and not (args.query or '').strip():
        raise ValueError('search/frame需要 --query 主题')
    if args.command == 'match' and not any(s.strip() for s in [args.title, args.abstract, args.keywords]):
        raise ValueError('match至少需要标题、摘要或关键词之一')
    rows = corpus.search(args.query, selected, args.mode, args.min_coverage) if args.query else None
    scoped = [r['article'] for r in rows] if rows is not None else selected
    if args.command == 'status':
        result = status(corpus, scoped)
    elif args.command == 'profile':
        result = profile(corpus, scoped)
    elif args.command == 'match':
        result = match_report(corpus, scoped, args)
    elif args.command == 'export':
        result = export_records(corpus, scoped, args.output, args.format, args.overwrite)
    else:
        result = {'matched_total': len(rows), 'results': [frame(r) if args.command == 'frame' else r for r in rows[:args.limit]]}
    return {'command': args.command, 'query': args.query, 'mode': args.mode,
            'notice': 'ranked为部分词元匹配，可能仅为相邻主题；phrase仅表示短语出现，仍须人工核对。',
            'limitations': LIMITATIONS, **result}


def main():
    args = parser().parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
    except (ValueError, OSError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
