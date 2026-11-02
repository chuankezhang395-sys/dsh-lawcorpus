/**
 * 框架抽取：把一篇论文的题录 + 摘要，拆成可复用的「框架卡」。
 *
 * 三层结构（对应使用场景）：
 *   表层  title pattern / 摘要长度 / 关键词数 / 体裁 / 栏目  → 仿写时对齐体例
 *   中层  摘要按功能分句，聚成槽位（问题—方法—结论）        → 仿写时对齐论证骨架
 *   深层  每张卡保留原句，供「照抄句式、换内容」            → 选题时看同行怎么起手
 *
 * 全部是规则 + 词表，不调用模型：一是离线可用，二是可复现（同一批语料永远同一结果），
 * 三是省 token（一篇文章只输出一张卡，不是整篇摘要）。
 */
import { splitSentences } from "./text.js";

/* ------------------------------ 体裁 ------------------------------ */

/** 体裁词表：每条 [词, 权重]。权重按「在法学论文里这个词多能指示体裁」人工给。 */
const GENRE_LEXICON = {
  实证研究: [["实证分析", 6], ["实证考察", 6], ["实证研究", 6], ["实证检视", 5], ["实证", 3], ["样本", 4], ["抽样", 3], ["回归", 3], ["变量", 2], ["显著性", 3], ["问卷", 3], ["描述性统计", 4], ["裁判文书", 3], ["判决书", 2], ["统计", 2], ["相关性", 1]],
  比较法: [["比较法", 6], ["域外", 3], ["大陆法系", 3], ["德国", 2], ["日本", 2], ["美国", 2], ["英国", 2], ["法国", 2], ["欧盟", 2], ["英美", 2], ["欧陆", 2], ["普通法", 2], ["借鉴", 2]],
  案例评析: [["案例评析", 6], ["指导性案例", 5], ["个案", 3], ["判例", 3], ["案号", 3], ["裁判理由", 3], ["案例", 2], ["二审", 2], ["再审", 2]],
  教义学: [["法教义学", 6], ["教义学", 6], ["构成要件", 5], ["请求权基础", 5], ["解释论", 4], ["体系解释", 4], ["涵摄", 4], ["文义解释", 3], ["目的解释", 3], ["规范构造", 3], ["法律适用", 2]],
  立法论: [["立法建议", 6], ["立法论", 5], ["立法完善", 4], ["修法", 4], ["制度构建", 3], ["规则设计", 3], ["应当规定", 2], ["条文", 2], ["草案", 2], ["对策", 1]],
  理论建构: [["理论建构", 6], ["范式", 3], ["重构", 3], ["正当性", 3], ["原理", 2], ["本体", 2], ["反思", 2], ["批判", 1], ["命题", 1]],
};

const GENRE_ORDER = ["实证研究", "案例评析", "比较法", "教义学", "立法论", "理论建构"];

/** 题名是作者最用力的地方，摘要次之，关键词多是选题词（「数据」「案例」这类通用词），
 *  权重压低，否则《数据跨境流动的规制模式》会因为标题里有「数据」被算成实证研究。 */
const FIELD_WEIGHT = { title: 2, abstract: 1, keywords: 0.6 };

function scoreField(text, genre) {
  let score = 0;
  for (const [word, weight] of GENRE_LEXICON[genre]) {
    if (!text.includes(word)) continue;
    score += weight * (text.split(word).length - 1);
  }
  return score;
}

function scoreGenre(article) {
  const fields = {
    title: article.title ?? "",
    abstract: article.abstract ?? "",
    keywords: (article.keywords ?? []).join(" "),
  };
  const scores = {};
  for (const genre of GENRE_ORDER) {
    let score = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
      score += scoreField(fields[field], genre) * weight;
    }
    scores[genre] = Math.round(score * 10) / 10;
  }
  return scores;
}

export function detectGenre(article) {
  const scores = scoreGenre(article);
  let best = "一般论述";
  let bestScore = 3;
  for (const genre of GENRE_ORDER) {
    if (scores[genre] > bestScore) {
      best = genre;
      bestScore = scores[genre];
    }
  }
  const secondary = GENRE_ORDER.filter((g) => g !== best && scores[g] >= 4).slice(0, 2);
  return { genre: best, scores, secondary };
}

/** 供 lawcorpus_match 用的信号位：只看强线索（权重 ≥3），免得通用词误报。 */
export function argumentSignals(article) {
  const text = `${article.title ?? ""} ${article.abstract ?? ""} ${(article.keywords ?? []).join(" ")}`;
  const has = (genre) => GENRE_LEXICON[genre].some(([word, weight]) => weight >= 3 && text.includes(word));
  return {
    实证: has("实证研究"),
    比较法: has("比较法"),
    案例: has("案例评析"),
    教义学: has("教义学"),
    立法建议: has("立法论"),
  };
}

/* ---------------------------- 标题句式 ---------------------------- */

const TITLE_PATTERNS = [
  { id: "dash-subtitle", label: "主副标题（——以X为视角/例）", test: (t) => /[—–]{1,2}/.test(t) && /(以|基于|兼|围绕).{2,}/.test(t.split(/[—–]{1,2}/).slice(1).join("")) },
  { id: "colon-subtitle", label: "冒号限定（X：以Y为中心/为例）", test: (t) => /[：:]/.test(t) && /(视角|为例|中心|切入点|展开|面向|检视)/.test(t.split(/[：:]/).slice(1).join("")) },
  { id: "cong-cong", label: "从X到Y（演进/位移）", test: (t) => /^从.{2,16}到.{2,20}$/.test(t) },
  { id: "lun", label: "论题式（论/也论/再论 + X）", test: (t) => /^(也论|再论|重论|补论|试论|略论|论)/.test(t) },
  { id: "question", label: "设问式（何以/如何/是否/？）", test: (t) => /[？?]$/.test(t) || /(何以|如何|能否|是否|为何|何谓|何去何从)/.test(t) },
  { id: "zhi", label: "之字结构（X之Y）", test: (t) => /之(争|辨|维|度|思|问|惑|辩|殇|困|变)/.test(t) },
  { id: "de-nominal", label: "偏正结构（X的Y：逻辑/基础/进路/限度）", test: (t) => /的(?:法律|理论|规范|制度|实践|社会|宪法|刑法|民法)?(?:逻辑|基础|进路|路径|构造|建构|反思|审视|限度|边界|展开|面向|体系|框架|机理|原理)$/.test(t) },
  { id: "compare", label: "比较法式（比较研究/域外考察）", test: (t) => /(比较研究|比较法|域外|借鉴|考察)/.test(t) },
  { id: "case", label: "案例切入式（以X案为例/个案）", test: (t) => /(为例|个案|判例|指导性案例|案评)/.test(t) },
  { id: "concept", label: "概念界定式（X的界定/性质/效力）", test: (t) => /(界定|性质|效力|属性|定位|内涵|外延|要件|类型|分类)/.test(t) },
  { id: "institution", label: "制度规则式（X制度的Y）", test: (t) => /(制度|规则|机制|规范|秩序|治理|模式|体系)/.test(t) },
];

export function detectTitlePattern(title) {
  const text = String(title ?? "").trim();
  for (const pattern of TITLE_PATTERNS) {
    if (pattern.test(text)) return { id: pattern.id, label: pattern.label };
  }
  return { id: "plain", label: "陈述式（无固定标记）" };
}

/* ---------------------------- 摘要分句 ---------------------------- */

const ROLE_LEXICON = {
  背景: ["随着", "近年来", "当前", "目前", "实践中", "司法实践", "我国", "社会", "经济", "技术发展", "数字时代", "转型"],
  问题: ["存在", "困境", "争议", "难题", "质疑", "不足", "局限", "冲突", "失衡", "风险", "挑战", "难以", "缺乏", "空白", "亟待", "困境在于", "但"],
  命题: ["本文认为", "笔者主张", "本文主张", "应当", "宜", "有必要", "需要", "核心命题", "基本立场", "本文提出", "可以认为"],
  方法: ["通过", "基于", "运用", "采用", "考察", "梳理", "比较", "实证", "样本", "案例", "规范分析", "教义学", "文本分析", "访谈", "问卷", "回归", "检验", "以…为"],
  结论: ["因此", "据此", "综上", "可见", "结论", "建议", "完善", "路径", "对策", "构建", "主张"],
  限定: ["限于", "仅就", "本文不", "暂不", "篇幅"],
};

export function classifySentence(sentence) {
  const text = String(sentence ?? "");
  let best = "铺陈";
  let bestScore = 0;
  const scores = {};
  for (const [role, words] of Object.entries(ROLE_LEXICON)) {
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score += word.length >= 4 ? 2 : 1;
    }
    scores[role] = score;
    if (score > bestScore) {
      best = role;
      bestScore = score;
    }
  }
  return { role: best, scores };
}

export function annotateSentences(abstract) {
  const sentences = splitSentences(abstract);
  return sentences.map((text, index) => {
    const { role } = classifySentence(text);
    return { index, role, text, chars: Array.from(text).length };
  });
}

const GENRE_DEFAULT_METHOD = {
  实证研究: "以裁判文书/样本数据为对象作描述统计与回归检验",
  比较法: "梳理域外（德日英美）规范与学说，反观中国法",
  案例评析: "以个案裁判为切口，检验规则的适用与漏洞",
  教义学: "现行法规范解释 + 学说梳理，构造要件与效果",
  立法论: "问题诊断 → 制度比较 → 条文/机制设计",
  理论建构: "概念澄清 → 原理证成 → 体系定位",
  一般论述: "问题提出 → 观点展开 → 结论",
};

export function extractSlots(sentences, genre) {
  const pick = (role) => sentences.find((s) => s.role === role);
  const problem = pick("问题") ?? pick("背景") ?? sentences[0] ?? null;
  const method = pick("方法") ?? null;
  const conclusion = [...sentences].reverse().find((s) => s.role === "结论") ?? sentences[sentences.length - 1] ?? null;
  return {
    problem: problem?.text ?? "",
    method: method?.text ?? GENRE_DEFAULT_METHOD[genre] ?? "",
    methodFromText: Boolean(method),
    conclusion: conclusion?.text ?? "",
  };
}

/* ---------------------------- 框架卡 ---------------------------- */

export function buildFrame(article) {
  const sentences = annotateSentences(article.abstract ?? "");
  const { genre, secondary } = detectGenre(article);
  const titlePattern = detectTitlePattern(article.title);
  const slots = extractSlots(sentences, genre);
  const abstractChars = Array.from(article.abstract ?? "").length;
  return {
    genre,
    genreSecondary: secondary,
    titlePattern,
    abstractChars,
    sentenceCount: sentences.length,
    keywordCount: (article.keywords ?? []).length,
    sentences,
    slots,
    signals: argumentSignals(article),
  };
}

/** 同句式 + 同体裁 → 记为一个可仿写模板。 */
export function aggregateTemplates(entries) {
  const buckets = new Map();
  for (const { article, frame } of entries) {
    const key = `${frame.genre}|${frame.titlePattern.id}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        genre: frame.genre,
        patternId: frame.titlePattern.id,
        patternLabel: frame.titlePattern.label,
        count: 0,
        samples: [],
        openers: [],
        keywords: new Map(),
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.samples.length < 3) bucket.samples.push(article.title);
    const opener = frame.sentences[0]?.text;
    if (opener && bucket.openers.length < 2) bucket.openers.push(opener);
    for (const kw of article.keywords ?? []) bucket.keywords.set(kw, (bucket.keywords.get(kw) ?? 0) + 1);
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((bucket) => ({
      genre: bucket.genre,
      pattern: bucket.patternLabel,
      count: bucket.count,
      samples: bucket.samples,
      openers: bucket.openers,
      topKeywords: [...bucket.keywords.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([word, n]) => `${word}(${n})`),
    }));
}
