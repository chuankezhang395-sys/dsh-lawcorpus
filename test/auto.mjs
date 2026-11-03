// 自动化回归：skill 安装、完整检索、体裁筛选、匹配评分、verbose 与 sample。
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
process.env.DSH_LAWCORPUS_TOOLS_SPEC = pathToFileURL(path.join(root, "test/stub.mjs")).href;

const registered = [];
const tools = { register: (t) => { registered.push(t); return () => {}; } };
const mkCtx = (logger = { info: () => {}, warn: () => {} }) => ({
  inject: (_deps, fn) => { fn({ tools, workingDirectory: { ensure: async () => root }, get: () => undefined }); },
  logger,
});

// —— 1. skill 自动安装：DSH_HOME 指向临时目录 ——
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lawcorpus-auto-"));
process.env.DSH_HOME = tmpHome;
const mod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
mod.apply(mkCtx(), {});

const skillTarget = path.join(tmpHome, "skills", "law-paper-writing", "SKILL.md");
const skillSource = path.join(root, "skill", "law-paper-writing", "SKILL.md");
assert.ok(fs.existsSync(skillTarget), "apply 后应自动拷贝 SKILL.md 到 DSH_HOME/skills");
assert.equal(
  fs.readFileSync(skillTarget, "utf8"),
  fs.readFileSync(skillSource, "utf8"),
  "拷贝内容应与源一致",
);
console.log("1. skill 自动安装 OK ->", skillTarget);

// —— 2. 目标已存在（含用户改过的版本）：绝不覆盖 ——
fs.writeFileSync(skillTarget, "用户改过的版本");
mod.apply(mkCtx(), {});
assert.equal(fs.readFileSync(skillTarget, "utf8"), "用户改过的版本", "已存在时不得覆盖");
console.log("2. 不覆盖已存在目标 OK");

// —— 3. DSH_HOME 未设置：仅告警跳过，不抛错 ——
delete process.env.DSH_HOME;
const warns = [];
mod.apply(mkCtx({ info: () => {}, warn: (m) => warns.push(String(m)) }), {});
assert.ok(warns.some((m) => m.includes("未设置 DSH_HOME")), "应告警跳过");
console.log("3. 未设置 DSH_HOME 告警跳过 OK");

// —— 4. 体裁筛选必须在完整主题结果上进行，不能制造假阴性 ——
const frame = registered.find((t) => t.name === "lawcorpus_frame");
const empirical = await frame.execute(
  { topic: "数据", genre: "实证研究", limit: 8 },
  { agent: "x", signal: undefined },
);
assert.ok(empirical.cards.length > 0, "全库存在「数据 + 实证研究」结果，不得误报为空");
assert.ok(empirical.cards.every((c) => c.frame.genre === "实证研究"), "卡片必须满足体裁筛选");
console.log(`4. 完整结果体裁筛选 OK（matched=${empirical.matched}, cards=${empirical.cards.length}）`);

// —— 5. 窄刊过滤不得被全局候选窗口截断，matched 应是完整主题命中数 ——
const journalHits = await frame.execute(
  { topic: "规制", journal: "中外法学", limit: 8 },
  { agent: "x", signal: undefined },
);
assert.equal(journalHits.matched, 16, "《中外法学》「规制」应保留全部 16 条主题命中");
assert.equal(journalHits.cards.length, 8, "卡片数量仍受 limit 限制");
console.log("5. 过滤后完整检索与计数 OK");

// —— 6. 匹配分应使用绝对覆盖率，不再让第一名恒为 100 ——
const match = registered.find((t) => t.name === "lawcorpus_match");
const sample = JSON.parse(fs.readFileSync(path.join(root, "data", "articles_zgfx2024.jsonl"), "utf8").split(/\r?\n/)[0]);
const exact = await match.execute(
  { title: sample.title, abstract: sample.abstract, keywords: sample.keywords },
  { agent: "x", signal: undefined },
);
const weak = await match.execute(
  { abstract: "火星基地拆迁补偿制度研究" },
  { agent: "x", signal: undefined },
);
assert.ok(exact.score >= 95, "完整题录查询应有高覆盖率");
assert.ok(weak.score < 100 && weak.score < exact.score, "弱相关查询不得获得 100 分");
console.log(`6. 匹配评分 OK（exact=${exact.score}, weak=${weak.score}）`);

// —— 7. verbose 必须进入返回值，渲染逐年矩阵 ——
const statusTool = registered.find((t) => t.name === "lawcorpus_status");
const status = await statusTool.execute({ verbose: true }, { agent: "x", signal: undefined });
const rendered = statusTool.output.render({ verbose: true }, status);
assert.ok(rendered[0].text.includes("逐年分布"), "verbose=true 应渲染逐年分布");
console.log("7. status verbose OK");

// —— 8. sample 表示真实上限，sample=1 不得被强制改成 10 ——
const profile = registered.find((t) => t.name === "lawcorpus_profile");
const one = await profile.execute({ topic: "数据", sample: 1 }, { agent: "x", signal: undefined });
assert.equal(one.total, 1, "sample=1 应只使用一篇");
console.log("8. profile sample OK");

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log("auto: ALL OK");
