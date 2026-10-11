// capture.mjs — 回合准确性契约（RED）
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { captureTurn } from "../src/capture.mjs";
import { TurnDedupe, turnKey } from "../src/dedupe.mjs";

const IDENTITY = { serviceId: "default", userId: "usr-t", teamId: "team-t", agentId: "agt-t", taskId: "task-t" };

function harness({ sendImpl, readBackImpl } = {}) {
  const calls = [];
  const client = {
    addConversation: async (args) => {
      calls.push(args);
      if (sendImpl) return sendImpl(args);
      return { total: 2 };
    },
    queryConversation: async (args) => {
      calls.push({ query: args });
      if (readBackImpl) return readBackImpl(args);
      return { messages: [] };
    },
  };
  const dedupe = new TurnDedupe({ stateDir: undefined, memory: new Map() });
  return { calls, client, dedupe };
}

const TURN = {
  client: "opencode",
  provider: "step-5",
  sessionId: "sess-1",
  turnId: "msg-u1",
  originalUser: "你好",
  finalAssistant: "你好！有什么可以帮你？",
  status: "completed",
};

// G1: 完成的回合 → 正好一组 user+assistant L0 写入；session 命名空间 = client-sha256(sessionId)[:24]
{
  const h = harness();
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt.status, "acknowledged");
  const writes = h.calls.filter((c) => c.messages);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    writes[0].messages.map((m) => m.role),
    ["user", "assistant"],
  );
  const expected = `opencode-${createHash("sha256").update("sess-1").digest("hex").slice(0, 24)}`;
  assert.equal(writes[0].sessionId, expected);
  console.log("G1 completed turn writes one pair: PASS");
}

// G2: 取消/失败/空 final → 不写入（不伪造完整回合）
for (const status of ["cancelled", "failed"]) {
  const h = harness();
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, status }, dedupe: h.dedupe });
  assert.equal(receipt.status, "skipped");
  assert.equal(h.calls.filter((c) => c.messages).length, 0);
  console.log(`G2 ${status} turn not captured: PASS`);
}
{
  const h = harness();
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, finalAssistant: "" }, dedupe: h.dedupe });
  assert.equal(receipt.status, "skipped");
  console.log("G2 empty final assistant not captured: PASS");
}

// G3: opt-out/凭据 → 整轮跳过
{
  const h = harness();
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, originalUser: "[不记忆]x" }, dedupe: h.dedupe });
  assert.equal(receipt.status, "skipped");
  const receipt2 = await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, originalUser: "k", finalAssistant: "sk-abcdefghijklmnopqrst" }, dedupe: h.dedupe });
  assert.equal(receipt2.status, "skipped");
  console.log("G3 privacy skip: PASS");
}

// G4: 重复 turnId → 第二次不产生新写入（同一 dedupe 实例）
{
  const h = harness();
  await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt.status, "duplicate");
  assert.equal(h.calls.filter((c) => c.messages).length, 1);
  console.log("G4 same turnId deduped: PASS");
}

// G5: 不同 turnId 的相同文本 → 不去重（turnKey 含 turnId，不用 hash(userText)）
{
  const h = harness();
  await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, turnId: "msg-u2" }, dedupe: h.dedupe });
  assert.equal(h.calls.filter((c) => c.messages).length, 2);
  console.log("G5 same text different turn not deduped: PASS");
}

// G6: 未知 ACK（发送后无响应）→ 标记 unknown，不盲目重试
{
  let attempts = 0;
  const h = harness({
    sendImpl: () => {
      attempts += 1;
      throw Object.assign(new Error("network reset after send"), { delivery: "maybe_sent" });
    },
  });
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt.status, "unknown");
  assert.equal(attempts, 1);
  // 再次触发同 turn → 不自动重试（保持 unknown，等显式对账）
  const receipt2 = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt2.status, "unknown");
  assert.equal(attempts, 1);
  console.log("G6 unknown ack not blindly retried: PASS");
}

// G7: 未发送即失败（连接拒绝）→ pending 保留可重试
{
  let attempts = 0;
  const h = harness({
    sendImpl: () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("ECONNREFUSED"), { delivery: "definitely_not_sent" });
      return { total: 2 };
    },
  });
  const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt.status, "retryable");
  const receipt2 = await captureTurn({ client: h.client, identity: IDENTITY, turn: TURN, dedupe: h.dedupe });
  assert.equal(receipt2.status, "acknowledged");
  assert.equal(attempts, 2);
  console.log("G7 pre-send failure retryable: PASS");
}

// G8（R2 删除）：旧行为"服务端已有同内容 → 自动 acknowledged 不重写"是 P1-E 缺陷
// ——同内容不同 turn 是真实历史。现行契约：turnKey 是唯一主判据，内容匹配仅用于
// reconcile/spool 的疑似判重（见 DC1/DC2 与 retryQueuedCaptures 测试）。

// G9: 进程重启后（新 dedupe 实例 + 持久 state 目录）同 turn 不重写
{
  const dir = await import("node:fs").then((fs) => fs.mkdtempSync("/tmp/am-dedupe-"));
  const h1 = harness();
  const d1 = new TurnDedupe({ stateDir: dir });
  await captureTurn({ client: h1.client, identity: IDENTITY, turn: TURN, dedupe: d1 });
  const h2 = harness();
  const d2 = new TurnDedupe({ stateDir: dir }); // 模拟重启
  const receipt = await captureTurn({ client: h2.client, identity: IDENTITY, turn: TURN, dedupe: d2 });
  assert.equal(receipt.status, "duplicate");
  assert.equal(h2.calls.filter((c) => c.messages).length, 0);
  console.log("G9 restart-safe idempotent: PASS");
}

// ── R2 RED pins：Core v3 单条消息 1–8192 字符（v3-api 文档 §conversation/add）──

// D-L1: 超过 8192 字符的 user/assistant → 跳过捕获并给出结构化 reason（不悄悄截断）
{
  const long = "长".repeat(8193);
  for (const [field, turn] of [
    ["user", { ...TURN, originalUser: long }],
    ["assistant", { ...TURN, finalAssistant: long }],
  ]) {
    const h = harness();
    const receipt = await captureTurn({ client: h.client, identity: IDENTITY, turn, dedupe: h.dedupe });
    assert.equal(receipt.status, "skipped", `${field} over limit must skip`);
    assert.equal(receipt.reason, "message-too-long");
    assert.equal(h.calls.filter((c) => c.messages).length, 0, "over-limit message must never be sent");
    console.log(`D-L1 ${field} >8192 skipped with reason: PASS`);
  }
}

// D-L2: 恰好 8192 → 允许；8193 → 拒绝（边界）
{
  // 注意：不能用 x/y 等 base64 字符集构造（会被隐私层替换为占位符，绕过长验证）
  const exact = "中".repeat(8192);
  const h1 = harness();
  const r1 = await captureTurn({ client: h1.client, identity: IDENTITY, turn: { ...TURN, finalAssistant: exact }, dedupe: h1.dedupe });
  assert.equal(r1.status, "acknowledged", "exactly 8192 must be captured");
  const over = "中".repeat(8193);
  const h2 = harness();
  const r2 = await captureTurn({ client: h2.client, identity: IDENTITY, turn: { ...TURN, finalAssistant: over }, dedupe: h2.dedupe });
  assert.equal(r2.status, "skipped");
  console.log("D-L2 8192 boundary: PASS");
}

// D-L3: 非 ASCII 按码点计数（中文/ emoji 不按 UTF-16 单元误判）
{
  const emoji = "😀".repeat(4096); // 8192 个 UTF-16 单元 / 4096 码点
  const h = harness();
  const r = await captureTurn({ client: h.client, identity: IDENTITY, turn: { ...TURN, finalAssistant: emoji }, dedupe: h.dedupe });
  assert.equal(r.status, "acknowledged", "4096 emoji code points = 4096 chars, must be captured");
  const tooMany = "😀".repeat(8193); // 8193 码点 > 8192
  const h2 = harness();
  const r2 = await captureTurn({ client: h2.client, identity: IDENTITY, turn: { ...TURN, finalAssistant: tooMany }, dedupe: h2.dedupe });
  assert.equal(r2.status, "skipped", "8193 emoji code points must be skipped (code-point counting, not UTF-16)");
  console.log("D-L3 non-ASCII code-point counting: PASS");
}
