// cross-agent-memory opencode 插件集成测试（mock 网关 + mock opencode client）
import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const added = [];
let queryResponse = { messages: [] };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/v3/conversation/add") added.push(parsed);
    if (req.url === "/v3/conversation/query") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "ok", request_id: "test", data: queryResponse }));
      return;
    }
    const data =
      req.url === "/v3/conversation/search"
        ? { messages: [{ id: "m1", role: "user", content: "用户叫 Sandro，偏好中文" }] }
        : req.url === "/v3/atomic/search"
          ? { items: [{ id: "a1", content: "使用 Mac mini 工作站" }] }
          : req.url === "/v3/core/read"
            ? { content: "# User Narrative Profile\n工程师，流程纪律" }
            : { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, message: "ok", request_id: "test", data }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const dir = await mkdtemp(join(tmpdir(), "cam-test-"));
await mkdir(join(dir, "runtime/logs"), { recursive: true });
await writeFile(
  join(dir, "config.local.json"),
  JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    hubEndpoint: "http://127.0.0.1:8125",
    apiKey: "local-bearer-disabled-compatibility",
    serviceId: "default",
    identity: { userId: "usr-test", teamId: "team-test", agentId: "agt-test", taskId: "task-test" },
    timeouts: { recallMs: 1200, captureMs: 3000 },
    recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 12000 },
    queue: { retryBatchSize: 3, retryBudgetMs: 800 },
  }),
);

process.env.OPENCODE_CROSS_AGENT_MEMORY_DIR = dir;
const { CrossAgentMemory } = await import(
  `file://${process.env.HOME}/.config/opencode/plugin/cross-agent-memory.js`
);

// mock opencode client：两轮对话
const conversation = [
  { info: { id: "msg-u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "第一轮问题" }] },
  {
    info: { id: "msg-a1", role: "assistant", sessionID: "s1", time: { created: 1, completed: 2 } },
    parts: [{ type: "text", text: "第一轮回答" }],
  },
  { info: { id: "msg-u2", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "第二轮问题" }] },
  {
    info: { id: "msg-a2", role: "assistant", sessionID: "s1", time: { created: 3, completed: 4 } },
    parts: [{ type: "text", text: "第二轮回答" }],
  },
];
// mock opencode client：游标模拟真实时序（第二轮到时 a2 尚未产生）
let cursor = 1;
const conversation2 = [
  { info: { id: "u1s2", role: "user", sessionID: "s2" }, parts: [{ type: "text", text: "proxy question" }] },
  { info: { id: "a1s2", role: "assistant", sessionID: "s2", providerID: "tencentdb-agent-memory", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "proxy answer" }] },
];
const client = {
  session: {
    messages: async ({ path }) => (path?.id === "s2" ? conversation2 : conversation.slice(0, cursor)),
  },
};

const hooks = await CrossAgentMemory({ client });

// ── T1: chat.message 第一轮：召回 + 记录 user 消息
await hooks["chat.message"](
  { sessionID: "s1", messageID: "msg-u1" },
  { message: { id: "msg-u1" }, parts: [{ type: "text", text: "我的工作流是什么？" }] },
);

cursor = 2; // 第一轮 assistant 回答已产生

// ── T2: system.transform 注入（非代理模型）
const sysOut = { system: ["base prompt"] };
await hooks["experimental.chat.system.transform"](
  { sessionID: "s1", model: { providerID: "step-5", modelID: "x" } },
  sysOut,
);
console.log("T2 system injected:", sysOut.system.length === 2 && sysOut.system[1].includes("cross-agent-memory") ? "PASS" : "FAIL");

// ── T3: 代理模型跳过注入
const sysOut3 = { system: [] };
await hooks["experimental.chat.system.transform"](
  { sessionID: "s1", model: { providerID: "tencentdb-agent-memory", modelID: "x" } },
  sysOut3,
);
console.log("T3 proxy model skipped:", sysOut3.system.length === 0 ? "PASS" : "FAIL");

// ── T4: 第二轮 chat.message：应补写第一轮
cursor = 3; // 第二轮 user 消息已到达，a2 尚未产生
await hooks["chat.message"](
  { sessionID: "s1", messageID: "msg-u2" },
  { message: { id: "msg-u2" }, parts: [{ type: "text", text: "第二轮问题" }] },
);
console.log(
  "T4 prev-turn captured:",
  added.length === 1 &&
    added[0].messages[0].content === "第一轮问题" &&
    added[0].messages[1].content === "第一轮回答" &&
    added[0].team_id === "team-test" &&
    added[0].agent_id === "agt-test" &&
    added[0].session_id.startsWith("opencode-")
    ? "PASS"
    : `FAIL ${JSON.stringify(added)}`,
);

// ── T5: 同一轮重复触发不双写
await hooks["chat.message"](
  { sessionID: "s1", messageID: "msg-u2" },
  { message: { id: "msg-u2" }, parts: [{ type: "text", text: "第二轮问题" }] },
);
console.log("T5 no double-write:", added.length === 1 ? "PASS" : "FAIL");

// ── T7b: message.updated 完成即写（覆盖 run 模式）
cursor = 4;
await hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", providerID: "step-5", time: { created: 3, completed: 4 }, id: "msg-a2" } } } });
console.log("T7b message.updated captures:", added.length === 2 && added[1].messages[1].content === "第二轮回答" ? "PASS" : `FAIL ${JSON.stringify(added)}`);

// ── T6: session.idle 写最后一轮（已被 message.updated 写过 → 不双写）
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
console.log(
  "T6 idle no double-write:",
  added.length === 2 ? "PASS" : `FAIL ${JSON.stringify(added)}`,
);

// ── T7: 隐私退出标记跳过召回
await hooks["chat.message"](
  { sessionID: "s1", messageID: "msg-u3" },
  { message: { id: "msg-u3" }, parts: [{ type: "text", text: "这条不记忆 /nomemory" }] },
);
const sysOut7 = { system: [] };
await hooks["experimental.chat.system.transform"](
  { sessionID: "s1", model: { providerID: "step-5", modelID: "x" } },
  sysOut7,
);
console.log("T7 nomemory directive:", sysOut7.system.length === 0 ? "PASS" : "FAIL");

// ── T8: 代理模型会话跳过写入（代理已写 L0，防双写）
await hooks["chat.message"](
  { sessionID: "s2", messageID: "u1s2", model: { providerID: "tencentdb-agent-memory", modelID: "glm-5.3-flash" } },
  { message: { id: "u1s2" }, parts: [{ type: "text", text: "proxy question" }] },
);
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
console.log("T8 proxy-model session skips capture:", added.length === 2 ? "PASS" : `FAIL ${JSON.stringify(added)}`);

// ── T9: 进程重启后同一轮不重写（持久化幂等）
queryResponse = { messages: [] };
const hooks2 = await CrossAgentMemory({ client }); // 新实例 = 新进程，读同一 state 目录
await hooks2.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", providerID: "step-5", time: { created: 3, completed: 4 }, id: "msg-a2" } } } });
console.log("T9 restart-safe idempotent:", added.length === 2 ? "PASS" : `FAIL ${JSON.stringify(added)}`);

// ── T10: 服务端读回已存在同内容轮次 → 跳过写入
queryResponse = { messages: [{ role: "user", content: "第二轮问题" }, { role: "assistant", content: "第二轮回答" }] };
await hooks2["chat.message"](
  { sessionID: "s3", messageID: "u1s3" },
  { message: { id: "u1s3" }, parts: [{ type: "text", text: "第二轮问题" }] },
);
await hooks2.event({ event: { type: "session.idle", properties: { sessionID: "s3" } } });
console.log("T10 read-back dedupe:", added.length === 2 ? "PASS" : `FAIL ${JSON.stringify(added)}`);

server.close();
