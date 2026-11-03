# tools/ · 从 PDF 重建语料的脚本

这些脚本用于**从原始「可搜索」法学期刊 PDF 重建 `data/*.jsonl` 语料**，与插件本体（`lib/`）解耦。日常使用插件时不需要它们；只有当你想扩展语料（加新刊、加新年份、换数据源）时才用到。

## 文件

| 文件 | 用途 |
|---|---|
| `build_corpus.py` | 从单个 `pdftotext -raw` 文本抽取一篇篇论文的题名/作者/摘要/关键词/目录/期号/页码，输出一行一条的 JSONL。 |
| `run_batch.sh` | 批量跑 12 个（4 刊 × 3 年）PDF：先 `pdftotext -raw`，再 `build_corpus.py`，输出到 `data/`。 |
| `summary.py` | 汇总 `data/*.jsonl` 的质量报告（标准/笔谈/错误/乱码/缺期/缺摘要/缺关键词/缺目录 + 单字作者检测）。 |
| `analyze.py` | 结构探针（页序、期号分布、文章起点），排查新数据源结构时用。 |
| `任务书.md` | 建库执行规范（切分顺序、字段定义、抽取规则、质量门槛、工作顺序），扩展语料前先读。 |

## 用法

```bash
# 前置：装 xpdf 的 pdftotext（加入 PATH），Python 3.10+
bash tools/run_batch.sh "/path/to/pdf目录"   # PDF 目录缺省读 $PDF_DIR 或当前目录
python tools/summary.py                       # 汇总 data/*.jsonl 质量报告
python tools/build_corpus.py raw.txt 中国法学 2024 data/articles_zgfx2024.jsonl
```

## 抽取规则的边界（如实告知）

- **只处理「可搜索」PDF**（有文字层）；扫描件（无文字层）抽不出题录，需先 OCR。
- 各刊标题页结构不同（中国法学有「目次」块、中外法学有竖排英文封面、比较法研究页码带 `·`、法学研究无页码行），`build_corpus.py` 内已按四刊分别处理；**新刊需先对照 `analyze.py` 摸清结构再改**。
- 期号优先取页眉「刊名 XXXX 年第 X 期」或封面 `Vol./No.`，少数靠「期号缺口」回填，个别可能不精确。
- 体裁/句式是**规则 + 词表抽取**，只当骨架参考。
- 目录只抽标题小标题（一、/（一）/1.），遇「参考文献」即停，去页眉页脚与脚注。
