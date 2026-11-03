/**
 * dsh-lawcorpus 配置归一化。
 *
 * 设计取舍：不引入任何第三方依赖，也不调用任何外部 API。
 * 语料是插件自带 data/*.jsonl（自包含、只读），检索是内存 BM25，框架检测是规则 + 词表。
 * 理由：几千篇量级纯 JS 足够快；装一个原生 sqlite 模块反而会把「换台机器就装不上」的风险引进来。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** CLSCI（中国法学核心科研评价来源期刊）24 种，作为默认覆盖清单。 */
export const DEFAULT_JOURNALS = [
  "法学研究",
  "中国法学",
  "中外法学",
  "法学家",
  "法学",
  "政法论坛",
  "法律科学",
  "法制与社会发展",
  "现代法学",
  "清华法学",
  "法商研究",
  "环球法律评论",
  "比较法研究",
  "当代法学",
  "华东政法大学学报",
  "法学评论",
  "政治与法律",
  "法学论坛",
  "法学杂志",
  "国家检察官学院学报",
  "行政法学研究",
  "中国刑事法杂志",
  "知识产权",
  "东方法学",
];

/** 插件自带语料目录：data/*.jsonl（12 个文件、850 条题录）。 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeSettings(config = {}) {
  const raw = config && typeof config === "object" ? config : {};
  // 相对 dataDir 以插件目录为基准解析；旧版相对 process.cwd()，会落到宿主进程目录。
  const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
  const dataDir =
    typeof raw.dataDir === "string" && raw.dataDir.trim()
      ? path.resolve(pluginRoot, raw.dataDir.trim())
      : DEFAULT_DATA_DIR;
  const journals =
    Array.isArray(raw.journals) && raw.journals.length
      ? raw.journals.map((j) => String(j).trim()).filter(Boolean)
      : DEFAULT_JOURNALS;

  return {
    dataDir,
    journals,
    topK: clampInt(raw.topK, 4, 1, 12),
    maxCards: clampInt(raw.maxCards, 8, 1, 20),
    enableStatus: raw.enableStatus !== false,
    enableProfile: raw.enableProfile !== false,
    enableFrame: raw.enableFrame !== false,
    enableMatch: raw.enableMatch !== false,
    enableExport: raw.enableExport !== false,
  };
}

/** 期刊名归一：去书名号、去「（版）」「网络首发」等尾巴，便于跨来源对齐。 */
export function canonicalJournal(name) {
  if (!name) return "";
  let s = String(name)
    .replace(/[《》〈〉]/g, "")
    .replace(/\s+/g, "")
    .trim();
  s = s.replace(/[（(]\s*(?:网络首发|电子版|英文版|增刊|专刊)\s*[)）]/g, "");
  s = s.replace(/(?:网络首发|电子版)$/g, "");
  return s.trim();
}
