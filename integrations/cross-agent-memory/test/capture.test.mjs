import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureTurn, retryQueuedCaptures } from "../src/capture.mjs";
import { drainCaptureQueue, enqueueCapture } from "../src/state-store.mjs";

async function withRuntime(run) {
  const runtimeRoot = join(resolve(import.meta.dirname, ".."), "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeDir = await mkdtemp(join(runtimeRoot, "capture-test-"));
  try {
    await run(runtimeDir);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

const turn = {
  client: "codex",
  sourceSessionId: "source-session",
  user: "user content",
  assistant: "assistant content",
  submittedAt: "2026-08-08T00:00:00.000Z",
  completedAt: "2026-08-08T00:00:01.000Z"
};

test("captureTurn skips a credential-bearing turn before any gateway write", async () => {
  await withRuntime(async (runtimeDir) => {
    let writes = 0;
    const result = await captureTurn({
      ...turn,
      user: "api_key=private-key",
      runtimeDir,
      gatewayClient: { addConversation: async () => { writes += 1; } }
    });

    assert.deepEqual(result, { captured: false, queued: false, skipped: true });
    assert.equal(writes, 0);
    const queued = [];
    await drainCaptureQueue(3, async (record) => { queued.push(record); return true; }, { runtimeDir });
    assert.deepEqual(queued, []);
  });
});

test("captureTurn writes sanitized user and assistant messages with ISO timestamps", async () => {
  await withRuntime(async (runtimeDir) => {
    let received;
    const result = await captureTurn({
      ...turn,
      runtimeDir,
      user: `question data:text/plain;base64,${"A".repeat(500)}`,
      gatewayClient: { addConversation: async (sessionId, messages) => { received = { sessionId, messages }; } }
    });

    assert.deepEqual(result, { captured: true, queued: false });
    assert.match(received.sessionId, /^codex-[a-f0-9]{24}$/);
    assert.deepEqual(received.messages, [
      { role: "user", content: "question [已移除多媒体数据]", timestamp: "2026-08-08T00:00:00.000Z" },
      { role: "assistant", content: "assistant content", timestamp: "2026-08-08T00:00:01.000Z" }
    ]);
  });
});

test("captureTurn queues a sanitized write failure and fails open", async () => {
  await withRuntime(async (runtimeDir) => {
    const gatewayClient = {
      apiKey: "must-not-leak",
      addConversation: async () => { throw new Error("offline must-not-leak"); }
    };
    const result = await captureTurn({ ...turn, gatewayClient, runtimeDir });

    assert.deepEqual(result, { captured: false, queued: true });
    const queued = [];
    await drainCaptureQueue(3, async (record) => { queued.push(record); return false; }, { runtimeDir });
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
      { role: "user", content: "user content", timestamp: "2026-08-08T00:00:00.000Z" },
      { role: "assistant", content: "assistant content", timestamp: "2026-08-08T00:00:01.000Z" }
    ]);
    assert.equal(JSON.stringify(queued[0]).includes("must-not-leak"), false);
  });
});

test("retryQueuedCaptures removes a record when query finds both messages within two seconds", async () => {
  await withRuntime(async (runtimeDir) => {
    await enqueueCapture({
      memorySessionId: "codex-session",
      messages: [
        { role: "user", content: "same user", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    let writes = 0;
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async (sessionId, limit) => {
          assert.equal(sessionId, "codex-session");
          assert.equal(limit, 20);
          return { messages: [
            { role: "assistant", content: "same assistant", timestamp: "2026-08-08T00:00:02.900Z" },
            { role: "user", content: "same user", timestamp: "2026-08-07T23:59:58.100Z" }
          ] };
        },
        addConversation: async () => { writes += 1; }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(result, { processed: 1, removed: 1, remaining: 0, budgetExceeded: false });
    assert.equal(writes, 0);
  });
});

test("retryQueuedCaptures writes unmatched records, stops on failure, and leaves later records queued", async () => {
  await withRuntime(async (runtimeDir) => {
    for (const content of ["one", "two", "three"]) {
      await enqueueCapture({
        memorySessionId: `codex-${content}`,
        messages: [
          { role: "user", content, timestamp: "2026-08-08T00:00:00.000Z" },
          { role: "assistant", content: `reply:${content}`, timestamp: "2026-08-08T00:00:01.000Z" }
        ]
      }, { runtimeDir });
    }
    const writes = [];
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [] }),
        addConversation: async (sessionId) => {
          writes.push(sessionId);
          if (sessionId === "codex-two") throw new Error("still offline");
        }
      },
      retryBatchSize: 3,
      retryBudgetMs: 800,
      runtimeDir
    });

    assert.deepEqual(writes, ["codex-one", "codex-two"]);
    assert.deepEqual(result, { processed: 2, removed: 1, remaining: 2, budgetExceeded: false });
    const remaining = [];
    await drainCaptureQueue(3, async (record) => { remaining.push(record.memorySessionId); return true; }, { runtimeDir });
    assert.deepEqual(remaining, ["codex-two", "codex-three"]);
  });
});

test("retryQueuedCaptures processes at most three records and honors its total time budget", async () => {
  await withRuntime(async (runtimeDir) => {
    for (let index = 0; index < 4; index += 1) {
      await enqueueCapture({
        memorySessionId: `codex-${index}`,
        messages: [{ role: "user", content: String(index), timestamp: "2026-08-08T00:00:00.000Z" }]
      }, { runtimeDir });
    }
    const writes = [];
    const started = Date.now();
    const result = await retryQueuedCaptures({
      gatewayClient: {
        queryConversation: async () => ({ messages: [] }),
        addConversation: async (sessionId) => {
          writes.push(sessionId);
          if (sessionId === "codex-0") await new Promise((resolve) => setTimeout(resolve, 150));
        }
      },
      retryBatchSize: 99,
      retryBudgetMs: 40,
      runtimeDir
    });

    assert.ok(Date.now() - started < 130);
    assert.deepEqual(writes, ["codex-0"]);
    assert.deepEqual(result, { processed: 1, removed: 0, remaining: 4, budgetExceeded: true });
  });
});
