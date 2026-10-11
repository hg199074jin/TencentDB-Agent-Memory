// observability.mjs — 无原文指标契约（RED）
import assert from "node:assert/strict";
import { Observability } from "../src/observability.mjs";

// O1: recall/capture 计数、延迟分桶、失败分类；快照不含任何原文
{
  const obs = new Observability();
  obs.recordRecall({ client: "codex", ok: true, layers: { l1: 2, l3: true, l2: 1 }, chars: 800, elapsedMs: 120, degraded: [] });
  obs.recordRecall({ client: "codex", ok: false, errorClass: "transport", elapsedMs: 1200, degraded: ["l1", "l3", "l2"] });
  obs.recordCapture({ client: "opencode", status: "acknowledged", elapsedMs: 240 });
  obs.recordCapture({ client: "opencode", status: "unknown", elapsedMs: 3000, errorClass: "timeout-after-send" });

  const snap = obs.snapshot();
  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes("用户"), "snapshot must not contain raw text");
  assert.equal(snap.recall.codex.ok, 1);
  assert.equal(snap.recall.codex.failed, 1);
  assert.equal(snap.capture.opencode.acknowledged, 1);
  assert.equal(snap.capture.opencode.unknown, 1);
  assert.ok(snap.recall.codex.latencyMs.p50 >= 0);
  assert.ok(snap.capture.opencode.latencyMs.max >= 3000);
  assert.equal(snap.failures.transport, 1);
  assert.equal(snap.failures["timeout-after-send"], 1);
  console.log("O1 metrics without raw text: PASS");
}

// O2: 延迟分桶与超预算计数（capture 预算 3000ms）
{
  const obs = new Observability();
  for (const ms of [50, 200, 600, 1500, 3200]) obs.recordCapture({ client: "codex", status: "acknowledged", elapsedMs: ms });
  const snap = obs.snapshot();
  assert.equal(snap.capture.codex.overBudget.count, 1, "only 3200ms exceeds the 3000ms budget");
  assert.equal(snap.capture.codex.count, 5);
  console.log("O2 latency buckets: PASS");
}
