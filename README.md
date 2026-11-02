# dsh-lawcorpus · 法学论文框架语料库

dsh-lawcorpus 是 DeepSeek Harness 插件，内置 2024–2026 年《中国法学》《比较法研究》《法学研究》《中外法学》四本 CLSCI 期刊共 850 篇真实论文的题名、作者、摘要、关键词与目录骨架。它不做全文检索，而是把论文「框架」结构化存成 JSONL，供选题、搭框架、仿写、投稿对标时检索真实语料。提供五个工具：status 查覆盖、profile 刊画像、frame 框架卡、match 投稿对标、export 导出。纯本地离线、零依赖、不回传服务器。

---

## 语料范围

| 期刊 | 2024 | 2025 | 2026 | 合计 |
|---|---|---|---|---|
| 中国法学 | 89 | 90 | 74 | 253 |
| 比较法研究 | 82 | 82 | 56 | 220 |
| 法学研究 | 69 | 70 | 58 | 197 |
| 中外法学 | 42 | 82 | 56 | 180 |
| **合计** | | | | **850**（含 3 篇笔谈/编者按） |

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
| `lawcorpus_export` | 导出 CSV / JSONL / Markdown | `format`、`journal`、`yearFrom`、`yearTo`、`outFile` |

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
- 语料在启动时载入内存并按文件 `mtime+size` 缓存；850 篇量级瞬间完成。

## 边界声明

- 语料为**题录层**（题名/作者/摘要/关键词/目录），不含全文，无法回答「某篇原文第几段写了什么」。
- 体裁、标题句式、功能句分类为规则抽取，供「骨架参考」，不是官方标注。
