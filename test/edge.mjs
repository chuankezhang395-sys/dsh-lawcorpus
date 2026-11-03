// 边界与回归：导出契约、路径安全、取消、检索过滤和参数钳制。
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
process.env.DSH_LAWCORPUS_TOOLS_SPEC = pathToFileURL(path.join(root, "test/stub.mjs")).href;
const mod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);

const registered = [];
const tools = { register: (t) => { registered.push(t); return () => {}; } };
const fakeCtx = {
  inject: (_deps, fn) => {
    const sctx = { tools, workingDirectory: { ensure: async () => root }, get: () => undefined };
    fn(sctx);
  },
  logger: { info: () => {}, warn: () => {} },
};
mod.apply(fakeCtx, {});
const get = (name) => registered.find((t) => t.name === name);
const execute = (name, args, signal) => get(name).execute(args, { agent: "x", signal });
const expectReject = async (promise, pattern) => {
  await assert.rejects(promise, pattern);
};

const tmp = fs.mkdtempSync(path.join(root, "test/tmp-"));
try {
  // 1. 三种导出格式及未知格式回退。
  const csv = await execute("lawcorpus_export", { format: "csv", outFile: path.join(tmp, "a.csv"), journal: "法学研究" });
  assert.equal(csv.count, 197);
  assert.ok(fs.readFileSync(csv.file, "utf8").startsWith("\uFEFF题名,"));

  const jsonl = await execute("lawcorpus_export", { format: "jsonl", outFile: path.join(tmp, "b.jsonl") });
  assert.equal(jsonl.count, 850);

  const markdown = await execute("lawcorpus_export", { format: "markdown", outFile: path.join(tmp, "c.md"), includeAbstract: false });
  assert.ok(fs.readFileSync(markdown.file, "utf8").includes("| 题名 |"));

  const fallback = await execute("lawcorpus_export", { format: "xls", outFile: path.join(tmp, "d.xls") });
  assert.ok(fs.readFileSync(fallback.file, "utf8").startsWith("\uFEFF题名,"));
  console.log("1. 导出格式 OK");

  // 2. JSONL 必须遵守 includeAbstract=false。
  const noAbstract = await execute("lawcorpus_export", {
    format: "jsonl",
    outFile: path.join(tmp, "no-abstract.jsonl"),
    includeAbstract: false,
  });
  const rows = fs.readFileSync(noAbstract.file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 850);
  assert.ok(rows.every((row) => !Object.hasOwn(row, "abstract")), "JSONL 不应包含 abstract 字段");
  console.log("2. JSONL includeAbstract=false OK");

  // 3. 默认不覆盖；显式 overwrite=true 才允许覆盖。
  await expectReject(
    execute("lawcorpus_export", { format: "csv", outFile: csv.file, journal: "法学研究" }),
    /overwrite=true/,
  );
  await execute("lawcorpus_export", { format: "csv", outFile: csv.file, journal: "法学研究", overwrite: true });
  console.log("3. 覆盖保护 OK");

  // 4. 禁止 .. 和工作区外绝对路径。
  await expectReject(
    execute("lawcorpus_export", { outFile: "../escape.csv" }),
    /会话工作区内/,
  );
  await expectReject(
    execute("lawcorpus_export", { outFile: path.join(path.dirname(root), "outside.csv") }),
    /会话工作区内/,
  );
  console.log("4. 导出路径边界 OK");

  // 5. 已取消的导出不得写文件。
  const controller = new AbortController();
  controller.abort();
  const cancelled = path.join(tmp, "cancelled.csv");
  await expectReject(execute("lawcorpus_export", { outFile: cancelled }, controller.signal), /操作已取消/);
  assert.equal(fs.existsSync(cancelled), false);
  console.log("5. 取消信号 OK");

  // 6. 自定义语料的 CSV 公式前缀必须中和。
  const customDir = path.join(tmp, "custom-data");
  fs.mkdirSync(customDir);
  fs.writeFileSync(path.join(customDir, "custom.jsonl"), JSON.stringify({
    id: "123456789abc",
    title: "=1+1",
    journal: "测试刊",
    year: 2026,
    authors: ["@cmd"],
    abstract: "+SUM(1,2)",
    keywords: ["-2+3"],
    outline: ["一、测试", "二、测试"],
    type: "paper",
  }) + "\n");
  mod.apply(fakeCtx, { dataDir: customDir });
  const customExport = registered.filter((t) => t.name === "lawcorpus_export").at(-1);
  const custom = await customExport.execute(
    { format: "csv", outFile: path.join(tmp, "formula.csv") },
    { agent: "x", signal: undefined },
  );
  const formulaCsv = fs.readFileSync(custom.file, "utf8");
  assert.ok(formulaCsv.includes("'=1+1"));
  assert.ok(formulaCsv.includes("'@cmd"));
  assert.ok(formulaCsv.includes("'+SUM(1,2)"));
  assert.ok(formulaCsv.includes("'-2+3"));
  console.log("6. CSV 公式注入防护 OK");

  // 7. 其它边界行为。
  const noHit = await execute("lawcorpus_frame", { topic: "zzzzzz" });
  assert.equal(noHit.cards.length, 0);
  assert.ok((await execute("lawcorpus_frame", { topic: "数据", limit: 0 })).cards.length > 0);
  assert.ok((await execute("lawcorpus_frame", { topic: "数据", limit: 999 })).cards.length <= 8);
  assert.ok((await execute("lawcorpus_match", { abstract: "摘要", limit: 100 })).nearest.length <= 6);
  await execute("lawcorpus_match", { abstract: "", title: "数字权利的宪法基础" });
  assert.equal((await execute("lawcorpus_status", { journal: "不存在的刊" })).total, 0);
  assert.equal((await execute("lawcorpus_frame", { topic: "数据", genre: "不存在的体裁" })).cards.length, 0);
  assert.equal((await execute("lawcorpus_profile", { journal: "中国法学", yearFrom: 2030, yearTo: 2020 })).total, 0);
  console.log("7. 其它边界行为 OK");

  // 8. status 按刊过滤时，缺口仍按全库覆盖计算（回归：曾把已覆盖刊误报为缺失）。
  const scopedStatus = await execute("lawcorpus_status", { journal: "法学研究" });
  for (const covered of ["法学研究", "中国法学", "中外法学", "比较法研究"]) {
    assert.ok(!scopedStatus.missingJournals.includes(covered), `${covered} 不应被列为「还没覆盖」`);
  }
  assert.equal(scopedStatus.missingJournals.length, 20, "缺口应为 24 - 4 = 20 刊");
  console.log("8. status 缺口按全库计算 OK");

  // 9. 单字主题词：frame 给提示、profile 抛可读错误。
  const lone = await execute("lawcorpus_frame", { topic: "权" });
  assert.equal(lone.matched, 0);
  assert.equal(lone.cards.length, 0);
  assert.ok(String(lone.hint).includes("单字"), "单字主题应返回提示");
  await expectReject(execute("lawcorpus_profile", { topic: "权" }), /单字主题词/);
  console.log("9. 单字主题提示 OK");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("edge: ALL OK");
