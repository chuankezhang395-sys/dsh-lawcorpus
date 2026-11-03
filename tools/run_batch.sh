#!/usr/bin/env bash
# 批量抽取「可搜索」法学期刊 PDF → 题录层 jsonl（输出到插件 data/ 目录）
# 用法: bash tools/run_batch.sh [PDF目录]
#   PDF目录 缺省读环境变量 PDF_DIR，再缺省用当前目录；pdftotext 从 PATH 里找。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PDF_DIR="${1:-${PDF_DIR:-.}}"
WORK="$ROOT/work"
DATA="$ROOT/data"
PD="$(command -v pdftotext || true)"
PY="${PYTHON:-python}"

if [ -z "$PD" ]; then
  echo "错误：未找到 pdftotext（xpdf），请先安装并加入 PATH。" >&2
  exit 1
fi

mkdir -p "$WORK" "$DATA"

# pdf 文件名 | 刊名 | 年份 | key
LINES=(
"中国法学2024年_可搜索.pdf|中国法学|2024|zgfx2024"
"中国法学2025年_可搜索.pdf|中国法学|2025|zgfx2025"
"中国法学2026年_可搜索.pdf|中国法学|2026|zgfx2026"
"中外法学2024_可搜索.pdf|中外法学|2024|zwfx2024"
"中外法学2025_可搜索.pdf|中外法学|2025|zwfx2025"
"中外法学2026_可搜索.pdf|中外法学|2026|zwfx2026"
"比较法研究2024_可搜索.pdf|比较法研究|2024|bjfyj2024"
"比较法研究2025_可搜索.pdf|比较法研究|2025|bjfyj2025"
"比较法研究2026_可搜索.pdf|比较法研究|2026|bjfyj2026"
"法学研究2024_可搜索.pdf|法学研究|2024|fxyj2024"
"法学研究2025_可搜索.pdf|法学研究|2025|fxyj2025"
"法学研究2026年_可搜索.pdf|法学研究|2026|fxyj2026"
)

for line in "${LINES[@]}"; do
  IFS='|' read -r fname journal year key <<< "$line"
  txt="$WORK/$key.txt"
  jsonl="$DATA/articles_$key.jsonl"
  echo "=== [$key] $journal $year ==="
  if [ ! -f "$txt" ]; then
    echo "  pdftotext -raw ..."
    "$PD" -raw -enc UTF-8 "$PDF_DIR/$fname" "$txt" 2> "$WORK/$key.err"
  else
    echo "  txt 已存在，跳过抽取"
  fi
  echo "  build_corpus ..."
  PYTHONIOENCODING=utf-8 "$PY" "$ROOT/tools/build_corpus.py" "$txt" "$journal" "$year" "$jsonl" > "$WORK/${key}_report.json" 2>&1
  tail -n 1 "$WORK/${key}_report.json" | head -c 400
  echo ""
done

echo "=== 全部完成 ==="
