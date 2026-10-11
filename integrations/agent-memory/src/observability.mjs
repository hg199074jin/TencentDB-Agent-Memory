/**
 * observability.mjs — 无原文指标。
 *
 * 只记录计数/延迟分桶/失败分类；绝不记录用户或助手原文、记忆内容。
 * 延迟分桶服务于 H 门（recall 1200ms / capture 3000ms 预算判定）。
 */

const BUCKETS = [50, 100, 250, 500, 1000, 1200, 2000, 3000];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function latencyAcc() {
  return { samples: [], p50: 0, p95: 0, max: 0 };
}

function recordLatency(acc, elapsedMs) {
  acc.samples.push(elapsedMs);
  if (acc.samples.length > 200) acc.samples.shift();
  const sorted = [...acc.samples].sort((a, b) => a - b);
  acc.p50 = percentile(sorted, 50);
  acc.p95 = percentile(sorted, 95);
  acc.max = sorted[sorted.length - 1];
}

export class Observability {
  constructor({ budgetMs = { recall: 1200, capture: 3000 }, logger } = {}) {
    this.budgetMs = budgetMs;
    this.logger = logger;
    this.recall = new Map(); // client → { ok, failed, latency, degradedLayers }
    this.capture = new Map(); // client → { count, byStatus, latency, overBudget }
    this.failures = new Map(); // errorClass → count
    this.startedAt = new Date().toISOString();
  }

  #recallBucket(client) {
    if (!this.recall.has(client)) {
      this.recall.set(client, { ok: 0, failed: 0, latency: latencyAcc(), degradedLayers: new Map() });
    }
    return this.recall.get(client);
  }

  #captureBucket(client) {
    if (!this.capture.has(client)) {
      this.capture.set(client, { count: 0, byStatus: new Map(), latency: latencyAcc(), overBudget: { count: 0, budgetMs: this.budgetMs.capture } });
    }
    return this.capture.get(client);
  }

  #countFailure(errorClass) {
    if (!errorClass) return;
    this.failures.set(errorClass, (this.failures.get(errorClass) ?? 0) + 1);
  }

  recordRecall({ client, ok, layers, chars, elapsedMs, degraded = [], errorClass }) {
    const bucket = this.#recallBucket(client);
    if (ok) bucket.ok += 1;
    else bucket.failed += 1;
    recordLatency(bucket.latency, elapsedMs);
    for (const layer of degraded) {
      bucket.degradedLayers.set(layer, (bucket.degradedLayers.get(layer) ?? 0) + 1);
    }
    if (!ok || degraded.length > 0) {
      this.#countFailure(
        errorClass ?? (degraded.length > 0 ? `recall-degraded:${degraded.join("+")}` : "recall-failed"),
      );
    }
    return { chars: chars ?? 0, elapsedMs };
  }

  recordCapture({ client, status, elapsedMs, errorClass }) {
    const bucket = this.#captureBucket(client);
    bucket.count += 1;
    bucket.byStatus.set(status, (bucket.byStatus.get(status) ?? 0) + 1);
    recordLatency(bucket.latency, elapsedMs);
    if (elapsedMs > bucket.overBudget.budgetMs) bucket.overBudget.count += 1;
    if (status === "unknown" || status === "retryable") this.#countFailure(errorClass ?? `capture-${status}`);
    return { status, elapsedMs };
  }

  snapshot() {
    const recall = {};
    for (const [client, bucket] of this.recall) {
      recall[client] = {
        ok: bucket.ok,
        failed: bucket.failed,
        latencyMs: { p50: bucket.latency.p50, p95: bucket.latency.p95, max: bucket.latency.max },
        degradedLayers: Object.fromEntries(bucket.degradedLayers),
      };
    }
    const capture = {};
    for (const [client, bucket] of this.capture) {
      capture[client] = {
        count: bucket.count,
        ...Object.fromEntries(bucket.byStatus),
        latencyMs: { p50: bucket.latency.p50, p95: bucket.latency.p95, max: bucket.latency.max },
        overBudget: bucket.overBudget,
      };
    }
    return {
      startedAt: this.startedAt,
      budgetMs: this.budgetMs,
      recall,
      capture,
      failures: Object.fromEntries(this.failures),
    };
  }
}
