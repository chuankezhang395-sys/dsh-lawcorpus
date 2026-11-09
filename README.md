# dsh-lawcorpus · 法学论文框架语料库

## 新增：网页版 Codex Cloud / Python 用法

现可直接使用仓库 Skill：`.agents/skills/law-paper-writing/SKILL.md`。Python 3.10+、仅标准库，不需要安装 DeepSeek Harness、Node.js 或API Key。原始 data 及旧插件完整保留。

你可以对 Codex 说：**“使用 law-paper-writing 检索离婚后未成年子女抚养费，区分直接命中与相邻主题，给出真实框架卡和出处。”**

```bash
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py status
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py search --query "抚养费" --mode phrase
python3 .agents/skills/law-paper-writing/scripts/lawcorpus.py frame --query "亲属扶养" --limit 3
```

完整说明：[Codex Cloud 中文使用说明](docs/CODEX_CLOUD_使用说明.md)；验证结果：[测试报告](docs/测试报告.md)。本库“抚养费”无直接短语命中；不能据此推断该领域没有研究。原PDF未附带，字段完整不代表抽取准确；已发现个别疑似截断题名，原样保留。

以下保留原 DeepSeek Harness 说明，其中数据完整率指字段覆盖，不代表逐篇核实：


一个 **DeepSeek Harness 插件**，内置近三年（2024–2026）四本 CLSCI 法学期刊（中国法学 / 比较法研究 / 法学研究 / 中外法学）真实论文的题名、作者、摘要、关键词与目录骨架，全部**本地离线、零依赖**。

做的是「论文框架语料库」：把期刊论文的**目录（章节小标题）、摘要、关键词、题名**结构化存成 JSONL，供模型在选题、仿写、投稿对标时检索与画像。**不存全文，不回传任何服务器。**

---

## 语料范围

> 下表为打包时的快照；具体篇数、按刊/按年分布、完整率以 `lawcorpus_status` 的实时输出为准。

| 期刊 | 2024 | 2025 | 2026 | 合计 |
|---|---|---|---|---|
| 中国法学 | 89 | 90 | 74 | 253 |
| 比较法研究 | 82 | 82 | 56 | 220 |
| 法学研究 | 69 | 70 | 58 | 197 |
| 中外法学 | 42 | 82 | 56 | 180 |
| **合计** | **282** | **324** | **244** | **850**（含 3 篇笔谈/编者按） |

- 850 = 847 篇标准论文 + 3 篇笔谈/编者按。
- 标准论文的**摘要 / 关键词 / 目录完整率均为 100%**，无乱码、无缺期号、无单字作者。
- 对照 CLSCI 24 种，还缺 20 本刊（当前只覆盖 4 本）。

### 数据源限制（如实声明）

1. **中外法学 2024** 只有 42 篇——源 PDF 本身只含第 3、4、6 三期（缺 1、2、5 期）。
2. **2026 年**各刊篇数偏少——期刊当年尚未出全。
3. 少数**期号**靠封面 `Vol./No.` 提取或按「期号缺口」回填，个别可能不精确。
4. 体裁（教义学/实证/比较法/案例评析等）与标题句式是**规则 + 词表抽取**，只当骨架参考，不保证与期刊官方分类一致。

---

## 五个工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `lawcorpus_status` | 语料覆盖情况：总篇数、按刊/按年、完整率、缺哪些刊 | `journal`、`verbose` |
| `lawcorpus_profile` | 体裁/句式/功能句/字数/关键词画像 | `journal`、`yearFrom`、`yearTo`、`genre`、`topic` |
| `lawcorpus_frame` | 按选题抽「框架卡」（问题/方法/结论槽位 + 目录骨架 + 高频词） | `topic`（必填）、`journal`、`genre`、`limit` |
| `lawcorpus_match` | 把你的摘要/标题/关键词对标本库，给出最近似论文与差距 | `abstract`（必填）、`title`、`keywords`、`journal` |
| `lawcorpus_export` | 导出 CSV / JSONL / Markdown | `format`、`journal`、`yearFrom`、`yearTo`、`outFile`、`includeAbstract`、`overwrite` |

导出仅允许写入会话工作区，默认不覆盖已有文件；确需覆盖时显式设置 `overwrite=true`。`lawcorpus_match` 的分数表示查询词元覆盖率，用于粗略参考，不代表语义相似概率或投稿录用概率。

典型用法示例：

```
lawcorpus_frame topic="数据可携权" journal="法学研究"
lawcorpus_match abstract="……" title="……" keywords=["……"] journal="中国法学"
lawcorpus_profile journal="中外法学" yearFrom=2024 yearTo=2026
lawcorpus_status verbose=true
```

---

## 安装（DeepSeek Harness desktop profile）

1. 把本目录放进 profile 的 `node_modules/dsh-lawcorpus`。
2. 在 profile 的 `cordis.patch.yml` 里插一条：

```yaml
- insert:
    - id: lawcorpus
      name: dsh-lawcorpus
      config:
        dataDir: ""
```

3. 在 profile `package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-lawcorpus"`。
4. 重启 DeepSeek Harness。

`dataDir` 留空即直接读插件自带的 `data/*.jsonl`（只读）。也可以改成自定义目录，放入同格式 JSONL 后本插件照常检索。

### JSONL 字段

每行一条记录（`data/articles_<刊>_<年>.jsonl`）：

```json
{"id":"…","journal":"中国法学","year":2024,"issue":4,"title":"…","authors":["…"],"abstract":"…","keywords":["…"],"outline":["一、…","二、…"],"outlineCount":5,"pages":"…","startPage":88,"type":"article","source":"…","quality":{},"extractedAt":"…"}
```

---

## 实现说明

- 纯 ESM、**零依赖**（无 sqlite / 原生模块），Node `^22.19.0 || >=24.0.0`。
- 检索 = 内存 BM25（字段权重：标题 3 / 关键词 4 / 摘要 1，汉字 bigram + 拉丁整词分词）。
- 语料在启动时载入内存并按文件 `mtime+size` 缓存；千篇以内量级瞬间完成。

## 自动触发（law-paper-writing skill）

本插件附带了全局 Skill `skill/law-paper-writing/SKILL.md`。插件加载时（apply 阶段）会**自动把它装进** harness-home 的 `skills/law-paper-writing/SKILL.md`（`DSH_HOME` 环境变量指向 harness-home），装完插件重启后即可自动触发，**无需手动拷贝**：检测到你在做**法学论文相关事项**（写摘要/标题/关键词/目录、选题、润色、审稿自查、投稿对标、搭论证框架）时会**自动调用** `lawcorpus_*` 工具，无需手动点名。详见该 SKILL.md 的触发规则与场景映射表。

自动安装只做「缺失时补齐」：目标文件已存在则不覆盖（保留你改过的版本）；`DSH_HOME` 未设置或插件包内缺源文件时仅告警跳过，不影响插件加载。若首次重启后 skill 尚未出现在技能列表，再重启一次即可。

> 提示：具体篇数、覆盖、完整率以 `lawcorpus_status` 的输出为准；SKILL.md 里不写死数字。

## 扩展语料（tools/）

`tools/` 目录提供从「可搜索」PDF 重建/扩展语料的脚本（`build_corpus.py` / `run_batch.sh` / `summary.py` / `analyze.py` / `任务书.md`）。想加新刊、加新年份、换数据源时先读 `tools/README.md` 与 `tools/任务书.md`，再用 `bash tools/run_batch.sh <PDF目录>` 重建 `data/*.jsonl`。日常查询无需这些脚本。

## 边界声明

- 语料为**题录层**（题名/作者/摘要/关键词/目录），不含全文，无法回答「某篇原文第几段写了什么」。
- 体裁、标题句式、功能句分类为规则抽取，供「骨架参考」，不是官方标注。

## 变更记录

- v0.2.2：修复 `lawcorpus_status` 按刊过滤时把已覆盖刊误报为「还没覆盖」；单字主题词查询给出明确提示；导出默认文件名改用本地时间（原为 UTC）；相对 `dataDir` 改为以插件目录为基准；`inject` 声明补全 `workingDirectory`；修正打包中 `tools/任务书.md` 文件名乱码。
- v0.2.1：`lawcorpus_frame` 体裁筛选假阴性修复、`lawcorpus_match` 评分改为词元覆盖率、导出路径安全加固、skill 安装防并发竞态、`lawcorpus_status` 增加 verbose 逐年矩阵。
- v0.2.0：首版。
