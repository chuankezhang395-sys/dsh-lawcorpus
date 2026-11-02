/**
 * 中文文本处理：归一化、bigram 切词、分句、BM25 检索。
 *
 * 为什么用 bigram 而不是词典分词：法学术语造词极快（「数据可携权」「算法解释权」
 * 「合规不起诉」），任何固定词典都会漏；bigram 加 BM25 的 IDF 已经把「本文」
 * 「研究」这类高频 bigram 自动压到接近 0，不需要维护停用词表。
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const FULLWIDTH_DIGIT = /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g;

export function normalizeText(value) {
  if (value == null) return "";
  let s = String(value);
  s = s.replace(/\u3000/g, " ");
  s = s.replace(FULLWIDTH_DIGIT, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\r\n?/g, "\n");
  return s.trim();
}

/** 去掉「【摘要】」「摘要：」「关键词：」这类导出时带上的标签。 */
export function stripLabels(value) {
  let s = normalizeText(value);
  s = s.replace(/^\s*[【\[]?\s*(?:摘\s*要|内容提要|abstract)\s*[】\]]?\s*[:：]?\s*/i, "");
  s = s.replace(/^\s*[【\[]?\s*(?:关\s*键\s*词|关键字|keywords?)\s*[】\]]?\s*[:：]?\s*/i, "");
  s = s.replace(/[【\[]\s*(?:摘\s*要|关\s*键\s*词)\s*[】\]]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** 去重 / 比对用的键：去标点空白、全小写。 */
export function normKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 关键词拆分：兼容中英文逗号、分号、顿号、竖线。 */
export function splitKeywords(value) {
  const raw = Array.isArray(value) ? value.join("；") : normalizeText(value);
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[；;，,、|/\\]+/)) {
    const k = stripLabels(part).replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!k) continue;
    const key = normKey(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** 切词：汉字走 bigram，拉丁字母/数字走整词。 */
export function tokenize(value) {
  const s = normalizeText(value).toLowerCase();
  if (!s) return [];
  const out = [];
  const runs = s.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9][a-z0-9._-]*/g);
  if (!runs) return out;
  for (const run of runs) {
    if (!CJK.test(run)) {
      if (run.length >= 2) out.push(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** 分句：中英文句末 + 分号 + 换行；过短的碎片并回上一句。 */
export function splitSentences(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const parts = text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    const len = Array.from(part).length;
    if (out.length && len < 6) {
      out[out.length - 1] = `${out[out.length - 1]}；${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

export function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

export function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.round((list.length - 1) * p)));
  return list[idx];
}

/**
 * BM25 索引。分字段打分再按权重相加：
 * 题名权重最高（题名就是句式模板本身），关键词次之（主题对齐），摘要兜底语义。
 */
export class SearchIndex {
  constructor({ weights = { title: 3, keywords: 4, abstract: 1 }, k1 = 1.2, b = 0.75 } = {}) {
    this.weights = weights;
    this.k1 = k1;
    this.b = b;
    this.docs = new Map();
    this.fields = new Map();
    for (const field of Object.keys(weights)) this.fields.set(field, { postings: new Map(), totalLen: 0 });
    this.finalized = false;
  }

  add(id, fields) {
    const entry = { len: {} };
    for (const [field, vocabulary] of this.fields) {
      const tokens = fields?.[field] ? tokenize(fields[field]) : [];
      entry.len[field] = tokens.length;
      vocabulary.totalLen += tokens.length;
      const local = new Map();
      for (const token of tokens) local.set(token, (local.get(token) ?? 0) + 1);
      for (const [token, tf] of local) {
        let list = vocabulary.postings.get(token);
        if (!list) {
          list = [];
          vocabulary.postings.set(token, list);
        }
        list.push([id, tf]);
      }
    }
    this.docs.set(id, entry);
  }

  finalize() {
    const n = this.docs.size;
    for (const [field, vocabulary] of this.fields) {
      vocabulary.avgLen = n ? vocabulary.totalLen / n || 1 : 1;
    }
    this.size = n;
    this.finalized = true;
  }

  /** 返回 [{id, score}]，按分数降序。 */
  search(query, { topK = 8, minScore = 0 } = {}) {
    if (!this.finalized) this.finalize();
    const queryTokens = tokenize(query);
    if (!queryTokens.length || !this.size) return [];
    const scores = new Map();
    const seen = new Map();
    for (const token of queryTokens) seen.set(token, (seen.get(token) ?? 0) + 1);

    for (const [token, qtf] of seen) {
      for (const [field, vocabulary] of this.fields) {
        const list = vocabulary.postings.get(token);
        if (!list) continue;
        const df = list.length;
        const idf = Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
        const weight = this.weights[field] ?? 1;
        const avgLen = vocabulary.avgLen || 1;
        for (const [id, tf] of list) {
          const doc = this.docs.get(id);
          const len = doc?.len?.[field] ?? 0;
          const norm = this.k1 * (1 - this.b + (this.b * len) / avgLen);
          const contribution = weight * idf * ((tf * (this.k1 + 1)) / (tf + norm)) * Math.min(qtf, 3);
          scores.set(id, (scores.get(id) ?? 0) + contribution);
        }
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .filter((row) => row.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** 把任意相似度分数压到 0–100，便于展示（相对最高分归一）。 */
export function normalizeScores(rows) {
  if (!rows.length) return rows;
  const top = rows[0].score || 1;
  return rows.map((row) => ({ ...row, similarity: Math.max(0, Math.round((row.score / top) * 100)) }));
}
