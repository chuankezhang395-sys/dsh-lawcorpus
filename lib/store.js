/**
 * 本地语料存储：读插件自带 data/*.jsonl（多个文件，自包含、只读）。
 *
 * 为什么是 JSONL 而不是 SQLite：
 *   - 零依赖，换机器不会因为原生模块编译失败；
 *   - 纯文本，用户可以自己 grep、git 版本化、丢进别的脚本；
 *   - 几千篇的量级，全量进内存 + 内存 BM25 比查库还快。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normKey, SearchIndex } from "./text.js";
import { buildFrame } from "./extract.js";
import { DEFAULT_JOURNALS } from "./settings.js";

/** dataDir 下的语料文件名：articles_<刊名缩写>_<年>.jsonl，也接受任意 *.jsonl。 */
function listCorpusFiles(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dataDir, name))
    .sort();
}

export function articleId(article) {
  if (article.id && /^[0-9a-f]{12}$/i.test(article.id)) return article.id;
  const key = `${normKey(article.title)}|${article.year}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** 读 dataDir 下所有 *.jsonl，按 id 去重（后读覆盖先读，保证同名题名只留一份）。 */
export function readArticles(dataDir) {
  const files = listCorpusFiles(dataDir);
  const byId = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.title && parsed?.year) {
          const id = articleId(parsed);
          byId.set(id, parsed);
        }
      } catch {
        /* 坏行跳过，不影响其它记录 */
      }
    }
  }
  return [...byId.values()];
}

/* ------------------------------ 统计 ------------------------------ */

export function corpusStats(articles, journals = DEFAULT_JOURNALS) {
  const byJournal = new Map();
  const byYear = new Map();
  const matrix = new Map();
  let withAbstract = 0;
  let withKeywords = 0;
  let withOutline = 0;
  let editorial = 0;
  for (const article of articles) {
    byJournal.set(article.journal, (byJournal.get(article.journal) ?? 0) + 1);
    byYear.set(article.year, (byYear.get(article.year) ?? 0) + 1);
    const row = matrix.get(article.journal) ?? new Map();
    row.set(article.year, (row.get(article.year) ?? 0) + 1);
    matrix.set(article.journal, row);
    if (article.type === "editorial") {
      editorial += 1;
    } else {
      if ((article.abstract ?? "").length >= 40) withAbstract += 1;
      if ((article.keywords ?? []).length) withKeywords += 1;
      if ((article.outline ?? []).length >= 2) withOutline += 1;
    }
  }
  const total = articles.length;
  const paper = total - editorial;
  return {
    total,
    paper,
    editorial,
    withAbstract,
    withKeywords,
    withOutline,
    abstractCoverage: paper ? Math.round((withAbstract / paper) * 100) : 0,
    keywordCoverage: paper ? Math.round((withKeywords / paper) * 100) : 0,
    outlineCoverage: paper ? Math.round((withOutline / paper) * 100) : 0,
    years: [...byYear.keys()].sort(),
    byYear: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
    byJournal: Object.fromEntries([...byJournal.entries()].sort((a, b) => b[1] - a[1])),
    missingJournals: journals.filter((j) => !byJournal.has(j)),
    matrix: [...matrix.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([journal, years]) => ({ journal, years: Object.fromEntries([...years.entries()].sort((a, b) => a[0] - b[0])) })),
  };
}

export function selectArticles(articles, filters = {}) {
  const yearFrom = Number(filters.yearFrom) || 0;
  const yearTo = Number(filters.yearTo) || 9999;
  const type = filters.type;
  return articles.filter((article) => {
    if (filters.journal && article.journal !== filters.journal) return false;
    if (article.year < yearFrom || article.year > yearTo) return false;
    if (type === "paper" && article.type === "editorial") return false;
    if (type === "editorial" && article.type !== "editorial") return false;
    return true;
  });
}

/* ------------------------------ 检索 ------------------------------ */

const cache = new Map();

/** 语料 + 索引缓存：文件没变就不重建（BM25 建索引在几千篇量级是十几毫秒）。 */
export function loadCorpus(dataDir) {
  const files = listCorpusFiles(dataDir);
  if (!files.length) return { articles: [], index: null, stamp: null, files: [] };
  let stamp = "";
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      stamp += `${file}:${stat.mtimeMs}:${stat.size};`;
    } catch {
      /* 忽略单个文件 stat 失败 */
    }
  }
  const hit = cache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit;

  const articles = readArticles(dataDir);
  const index = new SearchIndex();
  for (const article of articles) {
    article.id = articleId(article);
    index.add(article.id, {
      title: article.title,
      keywords: (article.keywords ?? []).join(" "),
      abstract: article.abstract,
    });
  }
  index.finalize();
  const entry = { articles, index, stamp, files };
  cache.set(dataDir, entry);
  return entry;
}

export function searchArticles(dataDir, query, { filters = {}, topK = 8 } = {}) {
  const { articles, index } = loadCorpus(dataDir);
  const allowed = new Set(selectArticles(articles, filters).map((article) => article.id));
  if (!index || !allowed.size) return [];
  const byId = new Map(articles.map((article) => [article.id, article]));
  const rows = index.search(query, { topK: Math.max(topK * 6, 30) }).filter((row) => allowed.has(row.id));
  return rows.slice(0, topK).map((row) => ({ article: byId.get(row.id), score: row.score }));
}

/** 把一批文献连同框架卡一起给出去（frame / profile 复用）。 */
export function framesOf(articles) {
  return articles.map((article) => ({ article, frame: buildFrame(article) }));
}
