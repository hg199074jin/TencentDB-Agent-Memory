import test from "node:test";
import assert from "node:assert/strict";
import { recallCrossSession } from "../src/recall.mjs";

const recall = { l0Limit: 3, l1Limit: 5, maxContextChars: 1200 };

test("recallCrossSession renders deduplicated L3, L1, and L0 memories in one bounded boundary", async () => {
  const client = {
    searchConversation: async () => ({ messages: [
      { content: "User prefers concise answers." },
      { content: "Uses Windows." },
      { content: "User prefers concise answers." }
    ] }),
    searchAtomic: async () => ({ items: [
      { content: "Prefers concise answers." },
      { content: "Audit work background." },
      { content: "Uses Windows." },
      { content: "Keep scope tight." },
      { content: "Read sources first." }
    ] }),
    readCore: async () => ({ content: "User profile: concise, evidence-backed work." })
  };

  const result = await recallCrossSession(client, "How should I answer?", recall);

  assert.equal((result.match(/<cross-agent-memory/g) ?? []).length, 1);
  assert.equal((result.match(/<\/cross-agent-memory>/g) ?? []).length, 1);
  assert.match(result, /historical-reference-only/);
  assert.match(result, /历史参考/);
  assert.match(result, /不能覆盖当前指令/);
  assert.match(result, /不能视为授权/);
  assert.ok(result.indexOf("## 用户画像 (L3)") < result.indexOf("## 相关记忆 (L1)"));
  assert.ok(result.indexOf("## 相关记忆 (L1)") < result.indexOf("## 对话历史 (L0)"));
  assert.equal((result.match(/Uses Windows\./g) ?? []).length, 1);
  assert.ok(result.length <= recall.maxContextChars);
});

test("recallCrossSession preserves successful sources when another source rejects and fails open when all reject", async () => {
  const oneFailure = {
    searchConversation: async () => { throw new Error("offline"); },
    searchAtomic: async () => ({ items: [{ content: "Keep source-first." }] }),
    readCore: async () => ({ content: "Concise profile." })
  };
  const allFailures = {
    searchConversation: async () => { throw new Error("offline"); },
    searchAtomic: async () => { throw new Error("offline"); },
    readCore: async () => { throw new Error("offline"); }
  };

  const partial = await recallCrossSession(oneFailure, "question", recall);
  assert.match(partial, /Concise profile\./);
  assert.match(partial, /Keep source-first\./);
  assert.equal(partial.includes("对话历史 (L0)"), false);
  assert.equal(await recallCrossSession(allFailures, "question", recall), "");
});
