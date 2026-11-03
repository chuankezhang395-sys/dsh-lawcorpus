/**
 * dsh-lawcorpus — 法学论文框架语料库（DeepSeek Harness 插件）。
 *
 * 语料：插件自带 data/*.jsonl，含近三年（2024–2026）四本 CLSCI 法学期刊的
 * 题名 / 作者 / 摘要 / 关键词 / 目录（章节小标题）/ 期号 / 页码，共 850 条题录。
 * 全部离线、只读、零依赖，检索是内存 BM25，框架检测是规则 + 词表。
 *
 * 工具一览：
 *   lawcorpus_status   看语料覆盖：多少篇、哪些刊、哪些年、摘要/关键词/目录完整率
 *   lawcorpus_profile  语料画像：体裁分布、标题句式、摘要长度、功能句占比、高频关键词
 *   lawcorpus_frame    给定选题，取 3–5 张「框架卡」：题录 + 分句功能 + 问题/方法/结论槽位
 *   lawcorpus_match    拿自己的摘要去对标：最像的同行论文 + 结构差距清单
 *   lawcorpus_export   导出 CSV / JSONL / Markdown，便于人工复核或交给别的工具
 *
 * 边界（有意为之）：
 *   - 只存题录、摘要、关键词、目录，不存全文；
 *   - 不调用任何大模型，抽取是规则 + 词表，结果可复现、零成本；
 *   - 单次只吐 3–5 张卡，绝不把上千篇摘要塞进上下文。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeSettings, DEFAULT_JOURNALS } from "./settings.js";
import {
  corpusStats,
  framesOf,
  loadCorpus,
  searchArticles,
  selectArticles,
} from "./store.js";
import { aggregateTemplates, buildFrame, detectGenre, detectTitlePattern } from "./extract.js";
import { isLoneCjkQuery, median, normalizeText, percentile } from "./text.js";

const PLUGIN = "dsh-lawcorpus";

const dshToolsSpec = process.env.DSH_LAWCORPUS_TOOLS_SPEC || "@deepseek-ai/dsh-tools";
const { defineTool: rawDefineTool } = await import(dshToolsSpec);

/**
 * 宿主注册工具时会校验 JSON Schema：每个 type: "object" 的节点都必须显式声明
 * additionalProperties，否则抛出 "unsupported JSON schema: schema.additionalProperties
 * must be explicitly true or false" 并拒绝注册（5 个工具会全部注册失败，表现为
 * 插件看着装好了但工具列表里一个都没有）。这里统一补成 false，只影响校验，不改工具行为。
 */
function hardenObjectSchemas(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) hardenObjectSchemas(item);
    return;
  }
  if (node.type === "object" && node.additionalProperties === undefined) {
    // 只有写全了 properties 的对象才收窄校验。不带 properties 的自由形态对象
    // （byJournal 的刊名键、matrix 行、genreMix/titlePatterns 项、yours/target 等）
    // 若被压成 false，每个真实键都会变成「未声明属性」，宿主会把工具返回值判成
    // invalid output，表现就是工具看着注册成功、一调用就报 schema 错误。
    const declared = node.properties && Object.keys(node.properties).length > 0;
    node.additionalProperties = declared ? false : true;
  }
  for (const key of Object.keys(node)) hardenObjectSchemas(node[key]);
}

function defineTool(spec) {
  if (spec?.output?.schema) hardenObjectSchemas(spec.output.schema);
  if (spec?.parameters) hardenObjectSchemas(spec.parameters);
  return rawDefineTool(spec);
}


const GENRE_NAMES = ["实证研究", "比较法", "案例评析", "教义学", "立法论", "理论建构", "一般论述"];

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  throw error;
}

/** 会话工作区：与内置 bash 工具同源；非取消错误才退回进程 cwd。 */
async function resolveSessionCwd(ctx, exec) {
  throwIfAborted(exec?.signal);
  if (!ctx || !exec || exec.agent === undefined) return undefined;
  try {
    const service = ctx.workingDirectory ?? (ctx.get && ctx.get("workingDirectory"));
    if (service && typeof service.ensure === "function") {
      const dir = await service.ensure(exec.agent, exec.signal);
      throwIfAborted(exec.signal);
      return typeof dir === "string" && dir.length > 0 ? dir : undefined;
    }
  } catch (error) {
    if (exec.signal?.aborted || error?.name === "AbortError") throw error;
    /* 其它工作区解析错误退到 process.cwd()。 */
  }
  return undefined;
}

function expandHome(input) {
  const raw = normalizeText(input);
  if (raw === "~") return process.env.HOME || process.env.USERPROFILE || raw;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "", raw.slice(2));
  }
  return raw;
}

/**
 * 把插件自带的 skill/law-paper-writing/SKILL.md 自动装进 harness-home 的
 * skills 目录，使「安装 + 重启」后即可自动触发，无需手动拷贝。
 * 只做「缺失时补齐」：目标已存在（哪怕是用户改过的版本）绝不覆盖；
 * DSH_HOME 未设置或插件内缺源文件时只告警跳过，不抛错、不影响插件加载。
 */
function ensureSkillInstalled(logger) {
  try {
    const home = process.env.DSH_HOME;
    if (!home) {
      logger?.warn?.(
        `[${PLUGIN}] 未设置 DSH_HOME，跳过 skill 自动安装（需要手动把 skill/law-paper-writing/ 拷到 harness-home 的 skills 目录）。`,
      );
      return;
    }
    const source = fileURLToPath(new URL("../skill/law-paper-writing/SKILL.md", import.meta.url));
    if (!fs.existsSync(source)) {
      logger?.warn?.(`[${PLUGIN}] 插件目录缺少 skill/law-paper-writing/SKILL.md，跳过自动安装。`);
      return;
    }
    const target = path.join(home, "skills", "law-paper-writing", "SKILL.md");
    if (fs.existsSync(target)) return; // 目标已存在：不覆盖。
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      // 排他创建，避免两个进程同时首次安装时检查后写入的竞态覆盖。
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === "EEXIST") return;
      throw error;
    }
    logger?.info?.(`[${PLUGIN}] 已自动安装 skill：${target}（新会话生效）。`);
  } catch (error) {
    logger?.warn?.(`[${PLUGIN}] skill 自动安装失败：${error?.message ?? error}`);
  }
}

/* --------------------------- 展示格式化 --------------------------- */

function cardMarkdown(card, index) {
  const { article, frame } = card;
  const head = `### ${index}. 《${article.title}》`;
  const meta = `《${article.journal}》${article.year}${article.issue ? `(${article.issue})` : ""} · ${frame.genre}` +
    `${frame.genreSecondary?.length ? `（含${frame.genreSecondary.join("/")}）` : ""} · ${frame.titlePattern.label}`;
  const chain = frame.sentences.map((s) => s.role).join("→");
  const lines = [head, "", meta];
  if (article.keywords?.length) lines.push(`- 关键词：${article.keywords.join(" / ")}`);
  lines.push(`- 摘要 ${frame.abstractChars} 字 · ${frame.sentenceCount} 句 · 功能链：${chain || "—"}`);
  if (article.outline?.length) {
    lines.push(`- 目录骨架（${article.outline.length} 条）：${article.outline.join(" ｜ ")}`);
  }
  const slots = [
    ["问题", frame.slots.problem],
    ["方法", frame.slots.method],
    ["结论", frame.slots.conclusion],
  ].filter(([, text]) => text);
  if (slots.length) {
    lines.push("- 槽位：");
    for (const [label, text] of slots) lines.push(`  - **${label}**：${text}`);
  }
  const signals = Object.entries(frame.signals)
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (signals.length) lines.push(`- 论证信号：${signals.join("、")}`);
  return lines.join("\n");
}

function templateMarkdown(templates) {
  if (!templates.length) return "";
  const lines = ["", "## 可仿写模板（同体裁 + 同句式，出现 ≥2 次）"];
  templates.slice(0, 6).forEach((tpl, i) => {
    lines.push(`${i + 1}. **${tpl.genre} · ${tpl.pattern}** — ${tpl.count} 篇`);
    if (tpl.samples?.length) lines.push(`   - 样例：${tpl.samples.map((s) => `《${s}》`).join("、")}`);
    if (tpl.openers?.length) lines.push(`   - 起手句：${tpl.openers[0]}`);
    if (tpl.topKeywords?.length) lines.push(`   - 常配关键词：${tpl.topKeywords.join("、")}`);
  });
  return lines.join("\n");
}

/* --------------------------- 工具实现 --------------------------- */

function buildStatusTool(settings) {
  return defineTool({
    name: "lawcorpus_status",
    description:
      "查看法学框架语料库的覆盖情况：总篇数（标准论文 + 笔谈）、按刊/按年分布、" +
      "摘要/关键词/目录完整率、对照 CLSCI 24 刊还缺哪些刊。语料是插件自带的近三年真实题录。",
    parameters: {
      journal: { type: "string", description: "只看某一本刊。" },
      verbose: { type: "boolean", description: "true 时额外列出每本刊的逐年分布矩阵。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          dataDir: { type: "string" },
          total: { type: "integer" },
          paper: { type: "integer" },
          editorial: { type: "integer" },
          years: { type: "array", items: { type: "integer" } },
          abstractCoverage: { type: "integer" },
          keywordCoverage: { type: "integer" },
          outlineCoverage: { type: "integer" },
          byJournal: { type: "object" },
          missingJournals: { type: "array", items: { type: "string" } },
          matrix: { type: "array", items: { type: "object" } },
          verbose: { type: "boolean" },
          hint: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (!value.total) {
          return [
            {
              type: "text",
              text:
                "语料库是空的。\n" +
                `· 语料目录：${value.dataDir}\n` +
                "· 本插件语料应打包在 data/*.jsonl，若缺失请重新安装插件或检查 dataDir 配置。",
            },
          ];
        }
        const lines = [
          `语料库：${value.total} 篇（标准论文 ${value.paper} 篇，笔谈/编者按 ${value.editorial} 篇）`,
          `· 年份：${value.years.join(" / ")}`,
          `· 标准论文完整率：摘要 ${value.abstractCoverage}%，关键词 ${value.keywordCoverage}%，目录 ${value.outlineCoverage}%`,
          "· 按刊：" + Object.entries(value.byJournal).map(([j, n]) => `${j} ${n}`).join("、"),
        ];
        if (value.missingJournals?.length) {
          lines.push(`· 还没覆盖（${value.missingJournals.length} 刊）：${value.missingJournals.join("、")}`);
        }
        if (value.hint) lines.push(`· ${value.hint}`);
        if (value.verbose && value.matrix?.length) {
          lines.push("", "逐年分布：");
          for (const row of value.matrix) {
            lines.push(`- ${row.journal}：${Object.entries(row.years).map(([y, n]) => `${y}年 ${n}`).join("，")}`);
          }
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const { articles, files } = loadCorpus(settings.dataDir);
      const scoped = args.journal ? articles.filter((a) => a.journal === args.journal) : articles;
      const stats = corpusStats(scoped, settings.journals);
      // 缺口按全库真实覆盖计算，不受当前刊名过滤影响；否则按刊过滤时会把已覆盖的其它刊误报为「还没覆盖」。
      const missingJournals = corpusStats(articles, settings.journals).missingJournals;
      const hint = `语料文件 ${files.length} 个，来自插件自带 data/ 目录。`;
      return {
        ok: true,
        dataDir: settings.dataDir,
        total: stats.total,
        paper: stats.paper,
        editorial: stats.editorial,
        years: stats.years,
        abstractCoverage: stats.abstractCoverage,
        keywordCoverage: stats.keywordCoverage,
        outlineCoverage: stats.outlineCoverage,
        byJournal: stats.byJournal,
        missingJournals,
        matrix: stats.matrix,
        verbose: args.verbose === true,
        hint,
      };
    },
  });
}

function profileOf(articles) {
  const entries = framesOf(articles);
  const genreMix = new Map();
  const patternMix = new Map();
  const roleMix = new Map();
  const keywordFreq = new Map();
  const pairFreq = new Map();
  const columnFreq = new Map();
  const abstractLens = [];
  const keywordCounts = [];
  const openers = [];

  for (const { article, frame } of entries) {
    genreMix.set(frame.genre, (genreMix.get(frame.genre) ?? 0) + 1);
    patternMix.set(frame.titlePattern.label, (patternMix.get(frame.titlePattern.label) ?? 0) + 1);
    if (frame.abstractChars) abstractLens.push(frame.abstractChars);
    keywordCounts.push(frame.keywordCount);
    if (article.column) columnFreq.set(article.column, (columnFreq.get(article.column) ?? 0) + 1);
    for (const sentence of frame.sentences) roleMix.set(sentence.role, (roleMix.get(sentence.role) ?? 0) + 1);
    const words = article.keywords ?? [];
    for (const word of words) keywordFreq.set(word, (keywordFreq.get(word) ?? 0) + 1);
    for (let i = 0; i < words.length; i += 1) {
      for (let j = i + 1; j < words.length; j += 1) {
        const pair = [words[i], words[j]].sort().join(" + ");
        pairFreq.set(pair, (pairFreq.get(pair) ?? 0) + 1);
      }
    }
    if (frame.sentences[0]) openers.push(frame.sentences[0].text);
  }

  const share = (map) => {
    const total = [...map.values()].reduce((sum, n) => sum + n, 0) || 1;
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, count: n, percent: Math.round((n / total) * 100) }));
  };

  return {
    total: entries.length,
    genreMix: share(genreMix),
    titlePatterns: share(patternMix),
    sentenceRoles: share(roleMix),
    topKeywords: [...keywordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
    keywordPairs: [...pairFreq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
    columns: share(columnFreq).slice(0, 10),
    abstractChars: {
      median: median(abstractLens),
      p25: percentile(abstractLens, 0.25),
      p75: percentile(abstractLens, 0.75),
    },
    keywordCount: { median: median(keywordCounts), p25: percentile(keywordCounts, 0.25), p75: percentile(keywordCounts, 0.75) },
    openers: openers.slice(0, 3),
    templates: aggregateTemplates(entries).slice(0, 10),
  };
}

function buildProfileTool(settings) {
  return defineTool({
    name: "lawcorpus_profile",
    description:
      "给语料库做画像（可按刊/按年/按体裁筛）：体裁分布、标题句式排行、摘要字数区间、关键词个数、" +
      "摘要功能句占比、高频关键词与共现组合、栏目分布、可仿写模板。想看「这家刊爱发什么、怎么起手」时用。",
    parameters: {
      journal: { type: "string", description: "限定某一本刊。" },
      yearFrom: { type: "integer", description: "起始年（含）。" },
      yearTo: { type: "integer", description: "结束年（含）。" },
      genre: { type: "string", description: `只看某类体裁：${GENRE_NAMES.join(" / ")}。` },
      topic: { type: "string", description: "只在该主题相关的论文上做画像（走 BM25 检索）。" },
      sample: { type: "integer", description: "topic 命中后最多用多少篇做画像，默认 40。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          total: { type: "integer" },
          genreMix: { type: "array", items: { type: "object" } },
          titlePatterns: { type: "array", items: { type: "object" } },
          sentenceRoles: { type: "array", items: { type: "object" } },
          abstractChars: { type: "object" },
          keywordCount: { type: "object" },
          topKeywords: { type: "array", items: { type: "object" } },
          keywordPairs: { type: "array", items: { type: "object" } },
          columns: { type: "array", items: { type: "object" } },
          openers: { type: "array", items: { type: "string" } },
          templates: { type: "array", items: { type: "object" } },
        },
      },
      render: (_args, value) => {
        if (!value.total) return [{ type: "text", text: "这个筛选条件下没有论文，先跑 lawcorpus_status 看覆盖。" }];
        const pct = (rows) => rows.map((r) => `${r.name} ${r.percent}%`).join("、");
        const lines = [`样本 ${value.total} 篇`, ""];
        lines.push(`**体裁**：${pct(value.genreMix)}`);
        lines.push(`**标题句式**：${pct(value.titlePatterns.slice(0, 6))}`);
        lines.push(`**摘要**：中位 ${value.abstractChars.median ?? "—"} 字（P25 ${value.abstractChars.p25 ?? "—"}，P75 ${value.abstractChars.p75 ?? "—"}），关键词中位 ${value.keywordCount.median ?? "—"} 个`);
        lines.push(`**摘要功能句**：${pct(value.sentenceRoles)}`);
        if (value.columns?.length) lines.push(`**栏目**：${pct(value.columns)}`);
        if (value.topKeywords?.length) lines.push(`**高频关键词**：${value.topKeywords.map((k) => `${k.name}(${k.count})`).join("、")}`);
        if (value.keywordPairs?.length) lines.push(`**关键词组合**：${value.keywordPairs.map((k) => `${k.name}(${k.count})`).join("、")}`);
        if (value.openers?.length) {
          lines.push("", "**起手句样例**：");
          for (const opener of value.openers) lines.push(`- ${opener}`);
        }
        return [{ type: "text", text: lines.join("\n") + templateMarkdown(value.templates) }];
      },
    },
    async execute(args) {
      const { articles } = loadCorpus(settings.dataDir);
      let scoped = selectArticles(articles, {
        journal: args.journal,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        type: "paper",
      });
      if (args.topic) {
        if (isLoneCjkQuery(args.topic)) {
          throw new Error(`「${args.topic}」是单字主题词：索引按双字词元（bigram）构建，单字查询必然查不到；请改用至少两个字的主题词（如「数据权利」）。`);
        }
        const requestedSample = Number(args.sample);
        const sample = Number.isFinite(requestedSample) && requestedSample > 0
          ? Math.min(Math.floor(requestedSample), 200)
          : 40;
        const hits = searchArticles(settings.dataDir, args.topic, {
          filters: { journal: args.journal, yearFrom: args.yearFrom, yearTo: args.yearTo, type: "paper" },
          topK: sample,
          minCoverage: 0.2,
        });
        scoped = hits.map((hit) => hit.article);
      }
      if (args.genre) {
        scoped = scoped.filter((article) => detectGenre(article).genre === args.genre);
      }
      const profile = profileOf(scoped);
      return { ok: true, ...profile };
    },
  });
}

function buildFrameTool(settings) {
  return defineTool({
    name: "lawcorpus_frame",
    description:
      "给定选题，从语料库里取 3–5 张「框架卡」：题录 + 体裁 + 标题句式 + 摘要分句功能注解 + " +
      "问题/方法/结论槽位 + 关键词 + 目录骨架，并附同体裁同句式的可仿写模板。写引言、搭论证骨架、找起手句时用这个。" +
      "只回少量卡片，不会把整库摘要塞进上下文。",
    parameters: {
      topic: { type: "string", required: true, description: "选题或关键概念，例如「数据可携权」「算法解释权」「合规不起诉」。" },
      journal: { type: "string", description: "限定某一本刊。" },
      yearFrom: { type: "integer", description: "起始年（含）。" },
      yearTo: { type: "integer", description: "结束年（含）。" },
      genre: { type: "string", description: `限定体裁：${GENRE_NAMES.join(" / ")}。` },
      limit: { type: "integer", description: "返回几张卡，默认取配置 topK（4），上限 maxCards。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          topic: { type: "string" },
          matched: { type: "integer" },
          cards: { type: "array", items: { type: "object" } },
          templates: { type: "array", items: { type: "object" } },
          hint: { type: "string" },
        },
      },
      render: (args, value) => {
        if (!value.cards?.length) {
          const head = value.matched > 0
            ? `「${args.topic}」命中 ${value.matched} 篇，但当前筛选下没有可展示的框架卡。`
            : `「${args.topic}」在现有语料里没命中。`;
          return [
            {
              type: "text",
              text:
                `${head}\n` +
                `${value.hint ?? ""}\n` +
                "可选：换更宽的关键词（如「数据」「算法」「合规」）、换体裁或去掉筛选，或先 lawcorpus_status 看覆盖年份和刊。",
            },
          ];
        }
        const lines = [`「${value.topic}」命中 ${value.matched} 篇，取前 ${value.cards.length} 张框架卡：`, ""];
        value.cards.forEach((card, index) => lines.push(cardMarkdown(card, index + 1), ""));
        if (value.hint) lines.push(`> ${value.hint}`);
        return [{ type: "text", text: lines.join("\n") + templateMarkdown(value.templates) }];
      },
    },
    async execute(args) {
      if (isLoneCjkQuery(args.topic)) {
        return {
          ok: true,
          topic: args.topic,
          matched: 0,
          cards: [],
          templates: [],
          hint:
            `「${args.topic}」是单字主题词：索引按双字词元（bigram）构建，单字查询必然落空。` +
            `请改用至少两个字的主题词（如「数据」「权利」组合成「数据权利」），或指定 journal 浏览某刊。`,
        };
      }
      const n1 = Number(args.limit);
      const limit = Math.min(Number.isFinite(n1) && n1 > 0 ? Math.floor(n1) : settings.topK, settings.maxCards);
      const filters = { journal: args.journal, yearFrom: args.yearFrom, yearTo: args.yearTo, type: "paper" };
      const total = loadCorpus(settings.dataDir).articles.length;
      // 先取完整主题结果，再筛选体裁并截取卡片，避免候选截断造成假阴性。
      const hits = searchArticles(settings.dataDir, args.topic, {
        filters,
        topK: Math.max(total, 1),
        minCoverage: 0.2,
      });
      const picked = args.genre
        ? hits.filter((hit) => detectGenre(hit.article).genre === args.genre)
        : hits;
      if (args.genre && hits.length && !picked.length) {
        return {
          ok: true,
          topic: args.topic,
          matched: hits.length,
          cards: [],
          templates: [],
          hint:
            `体裁「${args.genre}」无命中：主题命中 ${hits.length} 篇，但没有一篇属于该体裁。` +
            `可选体裁：${GENRE_NAMES.join(" / ")}；或去掉 genre 筛选重查。`,
        };
      }
      const cards = picked.slice(0, limit).map((hit) => ({ article: hit.article, frame: buildFrame(hit.article) }));
      const templates = aggregateTemplates(cards.map((card) => ({ article: card.article, frame: card.frame })));
      return {
        ok: true,
        topic: args.topic,
        matched: hits.length,
        cards,
        templates,
        hint: total
          ? `语料 ${total} 篇；命中按题名/关键词/摘要的 BM25 相似度排序。槽位与功能句是规则抽的，只当骨架参考。`
          : "语料库为空。",
      };
    },
  });
}

function buildMatchTool(settings) {
  return defineTool({
    name: "lawcorpus_match",
    description:
      "拿自己写的标题/摘要去对标语料库：给出最相似的同行论文（含框架卡）、目标刊的体例画像（体裁、字数、关键词数、标题句式），" +
      "以及一份结构差距清单（缺实证/缺比较法/字数偏差/关键词过少/标题句式不合该刊习惯）。投稿前自查用。",
    parameters: {
      abstract: { type: "string", required: true, description: "你写的摘要。" },
      title: { type: "string", description: "你的标题（可选，但给了才能判断句式）。" },
      keywords: { type: "array", items: { type: "string" }, description: "你的关键词。" },
      journal: { type: "string", description: "拟投刊物；给了就按这本刊的画像比对，不给就用全库。" },
      limit: { type: "integer", description: "返回几篇最近似论文，默认 3。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          score: { type: "integer" },
          yours: { type: "object" },
          target: { type: "object" },
          nearest: { type: "array", items: { type: "object" } },
          gaps: { type: "array", items: { type: "string" } },
          templates: { type: "array", items: { type: "object" } },
        },
      },
      render: (_args, value) => {
        const lines = [`**检索参考分 ${value.score}/100**（按查询词元覆盖率计算，不是语义相似概率）`, ""];
        if (value.yours) {
          lines.push(
            `你的稿子：${value.yours.genre} · ${value.yours.abstractChars} 字 · 关键词 ${value.yours.keywordCount} 个` +
              `${value.yours.titlePattern ? ` · ${value.yours.titlePattern}` : ""}`,
          );
        }
        if (value.target?.total) {
          lines.push(
            `对标样本（${value.target.scope}）：${value.target.total} 篇 · 主流体裁 ${value.target.topGenre} · ` +
              `摘要中位 ${value.target.abstractChars ?? "—"} 字 · 关键词中位 ${value.target.keywordCount ?? "—"} 个`,
          );
        }
        lines.push("", "**差距清单**");
        if (!value.gaps?.length) lines.push("- 没发现明显结构偏差。");
        for (const gap of value.gaps ?? []) lines.push(`- ${gap}`);
        if (value.nearest?.length) {
          lines.push("", "**最像的同行论文**");
          for (const item of value.nearest) {
            lines.push(`- 《${item.title}》（${item.journal} ${item.year}）· ${item.genre} · 词元覆盖率 ${item.similarity}%`);
          }
        }
        return [{ type: "text", text: lines.join("\n") + templateMarkdown(value.templates) }];
      },
    },
    async execute(args) {
      const { articles } = loadCorpus(settings.dataDir);
      if (!articles.length) throw new Error("语料库是空的。");

      const draft = {
        title: normalizeText(args.title ?? ""),
        abstract: normalizeText(args.abstract ?? ""),
        keywords: (args.keywords ?? []).map((k) => normalizeText(k)).filter(Boolean),
      };
      const draftFrame = buildFrame(draft);
      const query = `${draft.title} ${draft.abstract} ${draft.keywords.join(" ")}`;

      const scoped = args.journal
        ? articles.filter((article) => article.journal === args.journal && article.type !== "editorial")
        : articles.filter((article) => article.type !== "editorial");
      const targetProfile = profileOf(scoped);
      const hits = searchArticles(settings.dataDir, query, {
        filters: { journal: args.journal, type: "paper" },
        topK: (() => { const n2 = Number(args.limit);
          return Math.min(Number.isFinite(n2) && n2 > 0 ? Math.floor(n2) : 3, 6); })(),
      });
      const nearest = hits.map((hit) => ({
        title: hit.article.title,
        journal: hit.article.journal,
        year: hit.article.year,
        genre: detectGenre(hit.article).genre,
        // 使用查询词元覆盖率，避免“第一名相对自己永远 100 分”。
        similarity: Math.max(0, Math.min(100, Math.round((hit.coverage ?? 0) * 100))),
      }));
      const score = nearest.length ? nearest[0].similarity : 0;

      const gaps = [];
      const charMedian = targetProfile.abstractChars.median;
      const draftChars = draftFrame.abstractChars;
      if (charMedian && draftChars) {
        const delta = Math.round(((draftChars - charMedian) / charMedian) * 100);
        if (Math.abs(delta) > 30) {
          gaps.push(`摘要 ${draftChars} 字，对标中位 ${charMedian} 字（${delta > 0 ? "偏长" : "偏短"} ${Math.abs(delta)}%）；学术期刊摘要超过 ±30% 容易被认为没踩住体例。`);
        }
      }
      const kwMedian = targetProfile.keywordCount.median;
      if (kwMedian && draftFrame.keywordCount) {
        if (draftFrame.keywordCount < Math.max(3, kwMedian - 1)) {
          gaps.push(`关键词 ${draftFrame.keywordCount} 个，对标中位 ${kwMedian} 个；太少会让检索命中率下降。`);
        }
      } else if (!draftFrame.keywordCount) {
        gaps.push("没给关键词。中文法学期刊一般 3–5 个，且要能覆盖「对象 + 问题 + 方法」三层。");
      }

      const topGenre = targetProfile.genreMix[0];
      if (topGenre && topGenre.percent >= 35 && topGenre.name !== draftFrame.genre) {
        gaps.push(`对标样本里 ${topGenre.name} 占 ${topGenre.percent}%，你写的是 ${draftFrame.genre}；若不是有意跨体裁，先确认该刊吃不吃这类稿。`);
      }

      const empiricalShare = targetProfile.genreMix.find((g) => g.name === "实证研究");
      if (empiricalShare && empiricalShare.percent >= 25 && !draftFrame.signals.实证) {
        gaps.push(`对标样本里实证研究占 ${empiricalShare.percent}%，你的摘要没有任何数据/样本/检验表述。`);
      }
      const comparativeShare = targetProfile.genreMix.find((g) => g.name === "比较法");
      if (comparativeShare && comparativeShare.percent >= 20 && !draftFrame.signals.比较法) {
        gaps.push(`对标样本里比较法占 ${comparativeShare.percent}%，你的摘要没提域外经验。`);
      }

      const stillMissing = ["问题", "方法", "结论"].filter((role) => {
        if (role === "方法") return !draftFrame.slots.methodFromText;
        return !draftFrame.sentences.some((s) => s.role === role);
      });
      if (draftFrame.sentenceCount && stillMissing.length) {
        gaps.push(`摘要里没找到「${stillMissing.join("、")}」功能句；对标模板通常是 问题 → 方法 → 命题 → 结论 四段式。`);
      }

      if (!draft.title) {
        gaps.push("没给标题。标题句式是该刊最显性的体例特征，建议先看下面模板再定题。");
      } else if (detectTitlePattern(draft.title).id === "plain") {
        const pattern = targetProfile.titlePatterns[0];
        if (pattern) gaps.push(`标题是陈述式；对标样本最常见的是「${pattern.name}」（${pattern.percent}%）。`);
      }

      return {
        ok: true,
        score,
        yours: {
          genre: draftFrame.genre,
          abstractChars: draftFrame.abstractChars,
          keywordCount: draftFrame.keywordCount,
          titlePattern: draft.title ? draftFrame.titlePattern.label : "",
          sentenceCount: draftFrame.sentenceCount,
        },
        target: {
          scope: args.journal || "全库",
          total: targetProfile.total,
          topGenre: topGenre?.name ?? "—",
          abstractChars: charMedian,
          keywordCount: kwMedian,
          genreMix: targetProfile.genreMix,
          titlePatterns: targetProfile.titlePatterns.slice(0, 5),
        },
        nearest,
        gaps,
        templates: targetProfile.templates.slice(0, 6),
      };
    },
  });
}

function buildExportTool(settings, pluginCtx) {
  return defineTool({
    name: "lawcorpus_export",
    description:
      "把语料导出成 CSV / JSONL / Markdown，便于人工复核、发给导师、或交给别的脚本/git 存档。" +
      "支持按刊、按年筛选，可选择是否带摘要。",
    parameters: {
      outFile: { type: "string", description: "会话工作区内的输出路径；默认生成带日期时间的文件名。" },
      format: { type: "string", description: "csv（默认）/ jsonl / markdown。" },
      journal: { type: "string", description: "只导出某一本刊。" },
      yearFrom: { type: "integer", description: "起始年（含）。" },
      yearTo: { type: "integer", description: "结束年（含）。" },
      includeAbstract: { type: "boolean", description: "默认 true；false 时只出题录与关键词，体积小得多。" },
      overwrite: { type: "boolean", description: "目标已存在时是否覆盖，默认 false。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          file: { type: "string" },
          count: { type: "integer" },
          bytes: { type: "integer" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `✓ 导出 ${value.count} 条到 ${value.file}（${(value.bytes / 1024).toFixed(1)} KB）`,
        },
      ],
    },
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const cwd = path.resolve((await resolveSessionCwd(pluginCtx, exec)) || process.cwd());
      const { articles } = loadCorpus(settings.dataDir);
      const scoped = selectArticles(articles, { journal: args.journal, yearFrom: args.yearFrom, yearTo: args.yearTo });
      if (!scoped.length) throw new Error("这个筛选条件下没有可导出的记录。");
      const includeAbstract = args.includeAbstract !== false;
      const requestedFormat = (args.format || "csv").toLowerCase();
      const FORMATS = new Set(["csv", "jsonl", "markdown"]);
      const format = FORMATS.has(requestedFormat) ? requestedFormat : "csv";
      const ext = format === "markdown" ? "md" : format;
      // 本地时间戳：toISOString() 是 UTC，国内用户看到的默认文件名会差 8 小时。
      const pad2 = (n) => String(n).padStart(2, "0");
      const now = new Date();
      const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;

      const csvCell = (value) => {
        const raw = String(value ?? "");
        // 防止自定义语料在 Excel 等软件中被解释为公式。
        const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      let content = "";
      if (format === "jsonl") {
        content = scoped.map((article) => {
          if (includeAbstract) return JSON.stringify(article);
          const { abstract: _abstract, ...withoutAbstract } = article;
          return JSON.stringify(withoutAbstract);
        }).join("\n");
      } else if (format === "markdown") {
        const lines = ["| 题名 | 刊名 | 年 | 期 | 关键词 | 摘要 |", "| --- | --- | --- | --- | --- | --- |"];
        for (const article of scoped) {
          const esc = (v) => String(v ?? "").replace(/\|/g, "／").replace(/\r?\n/g, " ");
          lines.push(
            `| ${esc(article.title)} | ${esc(article.journal)} | ${article.year} | ${article.issue ?? ""} | ` +
              `${esc((article.keywords ?? []).join("、"))} | ${includeAbstract ? esc(article.abstract) : "—"} |`,
          );
        }
        content = lines.join("\n");
      } else {
        const header = ["题名", "作者", "刊名", "年", "期", "栏目", "页码", "关键词"].concat(includeAbstract ? ["摘要"] : []);
        const rows = [header.join(",")];
        for (const article of scoped) {
          const cells = [
            article.title,
            (article.authors ?? []).join("；"),
            article.journal,
            article.year,
            article.issue ?? "",
            article.column ?? "",
            article.pages ?? "",
            (article.keywords ?? []).join("；"),
          ];
          if (includeAbstract) cells.push(article.abstract ?? "");
          rows.push(cells.map(csvCell).join(","));
        }
        content = `\uFEFF${rows.join("\n")}\n`;
      }

      const target = args.outFile
        ? path.resolve(cwd, expandHome(args.outFile))
        : path.join(cwd, `lawcorpus-export-${stamp}.${ext}`);
      const isWithin = (root, candidate) => {
        const relative = path.relative(root, candidate);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      if (!isWithin(cwd, target)) {
        throw new Error("输出路径必须位于会话工作区内，不能使用绝对路径逃逸或 .. 跳转到其他目录。");
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 检查真实父目录，避免通过已存在的目录符号链接写出工作区。
      if (!isWithin(fs.realpathSync(cwd), fs.realpathSync(path.dirname(target)))) {
        throw new Error("输出目录的符号链接指向会话工作区外，已拒绝导出。");
      }
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        throw new Error("目标是符号链接，已拒绝覆盖。");
      }
      if (fs.existsSync(target) && args.overwrite !== true) {
        throw new Error("目标文件已存在；如确需覆盖，请设置 overwrite=true。");
      }
      throwIfAborted(exec?.signal);
      fs.writeFileSync(target, content, { encoding: "utf8", flag: args.overwrite === true ? "w" : "wx" });
      return { ok: true, file: target, count: scoped.length, bytes: Buffer.byteLength(content, "utf8") };
    },
  });
}

/* --------------------------- 插件入口 --------------------------- */

export const name = PLUGIN;
export const inject = ["tools", "workingDirectory"];

export function apply(ctx, config) {
  const settings = normalizeSettings(config);

  ensureSkillInstalled(ctx.logger);

  ctx.inject(["tools", "workingDirectory"], (sctx) => {
    const disposers = [];
    const register = (label, build) => {
      try {
        const dispose = sctx.tools.register(build());
        if (typeof dispose === "function") disposers.push(dispose);
      } catch (error) {
        ctx.logger?.warn?.(`[${PLUGIN}] 注册 ${label} 失败：${error?.message ?? error}`);
      }
    };

    const ctxForTools = { workingDirectory: sctx.workingDirectory, get: sctx.get?.bind(sctx) };

    if (settings.enableStatus) register("lawcorpus_status", () => buildStatusTool(settings));
    if (settings.enableProfile) register("lawcorpus_profile", () => buildProfileTool(settings));
    if (settings.enableFrame) register("lawcorpus_frame", () => buildFrameTool(settings));
    if (settings.enableMatch) register("lawcorpus_match", () => buildMatchTool(settings));
    if (settings.enableExport) register("lawcorpus_export", () => buildExportTool(settings, ctxForTools));

    ctx.logger?.info?.(
      `[${PLUGIN}] 已注册 ${disposers.length} 个工具 · dataDir=${settings.dataDir} · 覆盖清单 ${settings.journals.length} 刊`,
    );

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 卸载阶段忽略 */
        }
      }
    };
  });
}

export { DEFAULT_JOURNALS };
