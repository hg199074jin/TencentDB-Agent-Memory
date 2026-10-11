// M1-A RED：spool 不得因"内容相同"把不同 turn 判为已写并出队。
// 强契约（R3）：队列记录强制 turnKey；只有该 key 的真实 durable ACK 才自动出队；
// unknown 可报告 suspected，但内容匹配不得升级 acknowledged、不得删记录。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTurn, retryQueuedCaptures } from "../src/capture.mjs";
import { TurnDedupe, turnKey } from "../src/dedupe.mjs";

const IDENTITY = { serviceId: "default", teamId: "team-t", userId: "usr-t", agentId: "agt-t" };

function harness({ sendImpl } = {}) {
  const calls = [];
  const client = {
    addConversation: async (args) => {
      calls.push(args);
      if (sendImpl) return sendImpl(args);
      return { total: 2 };
    },
    queryConversation: async () => ({ messages: [] }),
  };
  return { calls, client };
}

function turn(turnId) {
  return { client: "codex", provider: "p", sessionId: "sess-same", turnId, originalUser: "完全相同的问题", finalAssistant: "完全相同的回答", status: "completed" };
}

// SA1: 不同 turn、相同内容 —— 第一轮已 ACK，第二轮 definitely_not_sent 入 spool，
// 恢复后第二轮必须真实写入（内容匹配不得冒充第二轮已 ACK）。
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-sa1-"));
  const added = [];
  const client = {
    addConversation: async (args) => {
      added.push(args);
      // 第二轮（turn-2）连接拒绝；其余成功
      if (args.messages[0].content === "完全相同的问题" && args.messages[1].content === "完全相同的回答" && added.filter((a) => a.messages[0].content === "完全相同的问题").length === 2) {
        throw Object.assign(new Error("ECONNREFUSED"), { delivery: "definitely_not_sent" });
      }
      return { total: 2 };
    },
    queryConversation: async () => ({ messages: [{ role: "user", content: "完全相同的问题" }, { role: "assistant", content: "完全相同的回答" }] }),
  };
  const dedupe = new TurnDedupe({ stateDir: dir });

  // 第一轮：成功
  const r1 = await captureTurn({ client, identity: IDENTITY, turn: turn("turn-1"), dedupe });
  assert.equal(r1.status, "acknowledged");

  // 第二轮：definitely_not_sent → retryable → 入 spool（模拟 hook-cli）
  const r2 = await captureTurn({ client, identity: IDENTITY, turn: turn("turn-2"), dedupe });
  assert.equal(r2.status, "retryable");
  const { enqueueCapture } = await import("../src/state-store.mjs");
  await enqueueCapture({ memorySessionId: r2.sessionId, messages: r2.messages, turnKey: r2.key }, { runtimeDir: dir });

  // 恢复重试：读回会发现"服务端已有同内容"（那是第一轮）——不得据此跳过第二轮
  const before = added.length;
  const retry = await retryQueuedCaptures({ coreClient: client, dedupe, runtimeDir: dir, retryBatchSize: 3, retryBudgetMs: 2000 });
  assert.equal(added.length, before + 1, "second turn must be actually written after recovery");
  assert.equal(retry.droppedSuspected, 0, "content match must not drop the second turn");
  assert.equal(dedupe.stateOf(r2.key), "acknowledged");
  console.log("SA1 second turn written after recovery (no content-match drop): PASS");
}

// SA2: 第二轮 maybe_sent → unknown；读回同内容只能报告 suspected，
// 不得自动 acknowledged、不得删除队列记录。
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-sa2-"));
  const added = [];
  const client = {
    addConversation: async (args) => {
      added.push(args);
      if (added.length === 2) throw Object.assign(new Error("timeout"), { delivery: "maybe_sent" });
      return { total: 2 };
    },
    queryConversation: async () => ({ messages: [{ role: "user", content: "完全相同的问题" }, { role: "assistant", content: "完全相同的回答" }] }),
  };
  const dedupe = new TurnDedupe({ stateDir: dir });
  const r1 = await captureTurn({ client, identity: IDENTITY, turn: turn("turn-1"), dedupe });
  assert.equal(r1.status, "acknowledged");
  const r2 = await captureTurn({ client, identity: IDENTITY, turn: turn("turn-2"), dedupe });
  assert.equal(r2.status, "unknown");

  const { enqueueCapture } = await import("../src/state-store.mjs");
  await enqueueCapture({ memorySessionId: r2.sessionId, messages: r2.messages, turnKey: r2.key }, { runtimeDir: dir });

  const beforeRetry = added.length; // turn-1 成功 + turn-2 的 maybe_sent 尝试
  const retry = await retryQueuedCaptures({ coreClient: client, dedupe, runtimeDir: dir, retryBatchSize: 3, retryBudgetMs: 2000 });
  assert.equal(added.length, beforeRetry, "unknown turn must not be resent during spool retry");
  assert.equal(dedupe.stateOf(r2.key), "unknown", "content match must not auto-acknowledge an unknown turn");
  assert.equal(retry.keptUnknown >= 1, true, "unknown record must stay in the spool for reconciliation");
  assert.equal(retry.suspectedUnknown >= 1, true, "suspected content match must be reported, not acted on");
  console.log("SA2 unknown stays unknown; suspected only reported: PASS");
}

// SA3: 无 turnKey 的历史队列记录 —— 内容匹配同样不得删除（保守保留，报告 suspected）
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-sa3-"));
  const added = [];
  const client = {
    addConversation: async (args) => { added.push(args); return { total: 2 }; },
    queryConversation: async () => ({ messages: [{ role: "user", content: "遗留问题" }, { role: "assistant", content: "遗留回答" }] }),
  };
  const dedupe = new TurnDedupe({ stateDir: dir });
  const { enqueueCapture } = await import("../src/state-store.mjs");
  await enqueueCapture({ memorySessionId: "codex-legacy", messages: [{ role: "user", content: "遗留问题" }, { role: "assistant", content: "遗留回答" }] }, { runtimeDir: dir });

  const retry = await retryQueuedCaptures({ coreClient: client, dedupe, runtimeDir: dir, retryBatchSize: 3, retryBudgetMs: 2000 });
  // 通过再次 drain 的处理结果验证记录仍在（removed=0）
  assert.equal(retry.processed.removed, 0, "legacy record without turnKey must not be dropped by content match");
  assert.equal(added.length, 0, "and must not be blindly resent either");
  assert.ok(retry.droppedSuspected >= 0);
  console.log("SA3 legacy no-key record retained (not dropped, not resent): PASS");
}
