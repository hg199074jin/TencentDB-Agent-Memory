// opencode 适配器集成测试（mock server + mock opencode client）
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// ── mock Core ──
const added = [];
let queryResponse = { messages: [] };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/v3/conversation/add") added.push(parsed);
    const data =
      req.url === "/v3/conversation/query"
        ? queryResponse
        : req.url === "/v3/atomic/search"
          ? { items: [{ content: "合成记忆：用户叫测试甲" }] }
          : req.url === "/v3/core/read"
            ? { content: "# 合成画像\n测试用户" }
            : req.url === "/v3/scenario/ls"
              ? { entries: [{ name: "s.md", summary: "合成场景" }] }
              : { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "ok", request_id: "t", data }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ── 隔离 integration root（config + runtime state） ──
const root = mkdtempSync(join(tmpdir(), "am-oc-"));
mkdirSync(join(root, "runtime"), { recursive: true });
writeFileSync(
  join(root, "config.local.json"),
  JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    hubEndpoint: "http://127.0.0.1:18125",
    apiKey: "test-bearer",
    serviceId: "default",
    identity: { userId: "usr-syn", teamId: "team-syn", agentId: "agt-syn", taskId: "task-syn" },
    timeouts: { recallMs: 1200, captureMs: 3000 },
    recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 8000 },
    queue: { retryBatchSize: 3, retryBudgetMs: 800 },
  }),
);
process.env.AGENT_MEMORY_ROOT = root;

const { CrossAgentMemory } = await import("../plugin/opencode-cross-agent-memory.js");

// ── mock opencode client（游标模拟时序） ──
const conversation = [
  { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "第一轮问题" }] },
  { info: { id: "a1", role: "assistant", sessionID: "s1", providerID: "step-5", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "第一轮回答" }] },
  { info: { id: "u2", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "第二轮问题" }] },
  { info: { id: "a2", role: "assistant", sessionID: "s1", providerID: "step-5", time: { created: 3, completed: 4 } }, parts: [{ type: "text", text: "第二轮回答" }] },
];
let cursor = 1;
const serverClient = { session: { messages: async () => conversation.slice(0, cursor) } };

const hooks = await CrossAgentMemory({ client: serverClient });

// OA1: chat.message 召回 + system.transform 注入（非代理模型）
await hooks["chat.message"](
  { sessionID: "s1", messageID: "u1", model: { providerID: "step-5", modelID: "x" } },
  { message: { id: "u1" }, parts: [{ type: "text", text: "我的偏好是什么" }] },
);
const sys = { system: ["base"] };
await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: { providerID: "step-5", modelID: "x" } }, sys);
assert.equal(sys.system.length, 2);
assert.ok(sys.system[1].includes("cross-agent-memory"));
assert.ok(sys.system[1].includes("合成画像"));
console.log("OA1 recall + inject on normal provider: PASS");

// OA2: 代理模型跳过注入
const sys2 = { system: [] };
await hooks["experimental.chat.system.transform"]({ sessionID: "s2", model: { providerID: "tencentdb-agent-memory", modelID: "glm" } }, sys2);
assert.equal(sys2.system.length, 0);
console.log("OA2 proxy provider skips injection: PASS");

// OA3: 代理模型会话 chat.message 完全静默（不召回不写）
const addedBefore = added.length;
await hooks["chat.message"](
  { sessionID: "s2", messageID: "x1", model: { providerID: "tencentdb-agent-memory", modelID: "glm" } },
  { message: { id: "x1" }, parts: [{ type: "text", text: "proxy 会话" }] },
);
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
assert.equal(added.length, addedBefore);
console.log("OA3 proxy session fully silent: PASS");

// OA4: 第二轮到达 → 补写第一轮（user+assistant 一对）
cursor = 3;
await hooks["chat.message"](
  { sessionID: "s1", messageID: "u2", model: { providerID: "step-5", modelID: "x" } },
  { message: { id: "u2" }, parts: [{ type: "text", text: "第二轮问题" }] },
);
assert.equal(added.length, 1, "prev turn captured once");
assert.equal(added[0].team_id, "team-syn");
assert.equal(added[0].agent_id, "agt-syn");
assert.deepEqual(added[0].messages.map((m) => m.role), ["user", "assistant"]);
assert.equal(added[0].messages[0].content, "第一轮问题");
assert.equal(added[0].messages[1].content, "第一轮回答");
console.log("OA4 prev-turn capture with identity: PASS");

// OA5: assistant 完成事件写第二轮；idle 不双写
cursor = 4;
await hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", providerID: "step-5", time: { created: 3, completed: 4 }, id: "a2" } } } });
assert.equal(added.length, 2);
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
assert.equal(added.length, 2, "idle must not double-write");
console.log("OA5 completion event + idle dedupe: PASS");

// OA6: 身份非法（配置缺字段）→ 不召回不写（fail-closed）
{
  const brokenRoot = mkdtempSync(join(tmpdir(), "am-oc-bad-"));
  mkdirSync(join(brokenRoot, "runtime"), { recursive: true });
  writeFileSync(
    join(brokenRoot, "config.local.json"),
    JSON.stringify({
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "test-bearer",
      serviceId: "default",
      identity: { userId: "usr-syn", teamId: "team-syn" }, // 缺 agentId
      timeouts: { recallMs: 1200, captureMs: 3000 },
      recall: {},
      queue: {},
    }),
  );
  const prevRoot = process.env.AGENT_MEMORY_ROOT;
  process.env.AGENT_MEMORY_ROOT = brokenRoot;
  // 动态导入新实例（模块缓存按路径，同一文件 → 需清缓存）
  const { default: fresh } = { default: null };
  const mod = await import(`../plugin/opencode-cross-agent-memory.js?broken=${Date.now()}`);
  const badHooks = await mod.CrossAgentMemory({ client: serverClient });
  const sysBad = { system: [] };
  await badHooks["chat.message"]({ sessionID: "s9", messageID: "z1", model: { providerID: "step-5" } }, { message: { id: "z1" }, parts: [{ type: "text", text: "hello" }] });
  await badHooks["experimental.chat.system.transform"]({ sessionID: "s9", model: { providerID: "step-5" } }, sysBad);
  assert.equal(sysBad.system.length, 0, "identity failure must not inject");
  await badHooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } });
  assert.equal(added.length, 2, "identity failure must not write");
  process.env.AGENT_MEMORY_ROOT = prevRoot;
  void fresh;
  console.log("OA6 identity fail-closed: PASS");
}

// OA7: Core 停服务 → chat.message 不抛错（fail-open，Agent 继续）
{
  server.close();
  const sysDown = { system: ["base"] };
  await hooks["chat.message"](
    { sessionID: "s3", messageID: "y1", model: { providerID: "step-5" } },
    { message: { id: "y1" }, parts: [{ type: "text", text: "core 挂了吗" }] },
  );
  await hooks["experimental.chat.system.transform"]({ sessionID: "s3", model: { providerID: "step-5" } }, sysDown);
  assert.deepEqual(sysDown.system, ["base"], "core down → no injection, no hang");
  console.log("OA7 core-down fail-open: PASS");
}
