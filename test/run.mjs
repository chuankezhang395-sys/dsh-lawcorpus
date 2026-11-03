// 冒烟测试：验证插件能加载、能注册 5 个工具、能读语料并跑通 status/profile/frame/match。
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
process.env.DSH_LAWCORPUS_TOOLS_SPEC = pathToFileURL(path.join(root, "test/stub.mjs")).href;

const mod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);

console.log("plugin name:", mod.name);
console.log("plugin inject:", JSON.stringify(mod.inject));

const registered = [];
const tools = { register: (tool) => { registered.push(tool); return () => {}; } };
const fakeCtx = {
  inject: (_deps, fn) => {
    const sctx = { tools, workingDirectory: { ensure: async () => root }, get: () => undefined };
    fn(sctx);
  },
  logger: { info: (m) => console.log("  [log]", m), warn: (m) => console.log("  [warn]", m) },
};

mod.apply(fakeCtx, {});
console.log("registered tools:", registered.map((t) => t.name).join(", "));

// 逐个跑 execute
const run = async (tool, args) => {
  const out = await tool.execute(args, { agent: "x", signal: undefined });
  console.log(`\n=== ${tool.name}(${JSON.stringify(args)}) ===`);
  console.log(JSON.stringify(out, null, 2).slice(0, 1200));
  return out;
};

const status = registered.find((t) => t.name === "lawcorpus_status");
await run(status, {});

const profile = registered.find((t) => t.name === "lawcorpus_profile");
await run(profile, { journal: "中国法学" });

const frame = registered.find((t) => t.name === "lawcorpus_frame");
await run(frame, { topic: "数据跨境流动", limit: 3 });

const match = registered.find((t) => t.name === "lawcorpus_match");
await run(match, { abstract: "本文以算法解释权为对象，通过比较域外立法并实证考察我国司法实践，提出算法解释权的规范构造与行使边界。", title: "算法解释权的规范构造与行使边界" });
