/**
 * hook-cli.mjs — Codex / Claude Code / ZCode 的薄原生事件适配器。
 *
 * CLI 契约不变：argv[2]=client，stdin=hook JSON，stdout=结果 JSON。
 * 事件：UserPromptSubmit（召回+暂存原始 prompt）、Stop（写入上一回合+重试队列）。
 *
 * 本文件只做最薄的协议适配；记忆语义全部来自统一模块：
 *   identity（授权作用域 fail-closed）→ core-client（v3）→ recall / capture / dedupe / observability。
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { captureTurn, retryQueuedCaptures } from "./capture.mjs";
import { loadConfig } from "./config.mjs";
import { CoreClient } from "./core-client.mjs";
import { TurnDedupe } from "./dedupe.mjs";
import { createIdentityPolicy, resolveScope } from "./identity.mjs";
import { Observability } from "./observability.mjs";
import { inspectTurn } from "./privacy.mjs";
import { recallMemory } from "./recall.mjs";
import { enqueueCapture, savePendingTurn, takePendingTurn } from "./state-store.mjs";

const CLIENTS = new Set(["codex", "claude", "zcode"]);
const RUNTIME_DIR = join(
  process.env.AGENT_MEMORY_ROOT ?? fileURLToPath(new URL("../", import.meta.url)),
  "runtime",
);
const STATUS_LOG = join(RUNTIME_DIR, "logs", "status.jsonl");
const PROCESS_STARTED_AT = Date.now();
const PROCESS_BUDGET_MS = 4_200;
const FINALIZATION_RESERVE_MS = 150;
const RETRY_START_RESERVE_MS = 900;
const WORK_DEADLINE = PROCESS_STARTED_AT + PROCESS_BUDGET_MS - FINALIZATION_RESERVE_MS;

const observability = new Observability();

function sessionDigest(value) {
  if (typeof value !== "string" || value === "") return "none";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function eventName(value) {
  if (value === "UserPromptSubmit" || value === "Stop") return value;
  return "unknown";
}

function errorClass(error) {
  return typeof error?.name === "string" && error.name !== "" ? error.name : "Error";
}

async function writeStatus({ client, event, session, status, error }) {
  try {
    await mkdir(join(RUNTIME_DIR, "logs"), { recursive: true });
    await appendFile(STATUS_LOG, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      client: CLIENTS.has(client) ? client : "unknown",
      event,
      session,
      status,
      errorClass: error ? errorClass(error) : null
    })}\n`, "utf8");
  } catch {
    // Diagnostics are fail-open and never include turn content or credentials.
  }
}

async function readInputLine() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) return line;
  return "";
}

function sourceSessionId(input) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  return sessionId.trim() === "" ? "" : sessionId;
}

function configWithinDeadline(config, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  return {
    ...config,
    timeouts: {
      recallMs: Math.min(config.timeouts.recallMs, remaining),
      captureMs: Math.min(config.timeouts.captureMs, remaining)
    }
  };
}

/**
 * 构建统一上下文：身份（fail-closed）+ v3 客户端 + 去重器。
 * @returns {{ ok: true, context: object } | { ok: false, reason: "config-error"|"identity-rejected" }}
 */
async function buildContext(client, deadline) {
  let config;
  try {
    config = configWithinDeadline(await loadConfig(), deadline);
  } catch {
    return { ok: false, reason: "config-error" };
  }
  const policy = createIdentityPolicy({ config, allowed: config.allowed });
  const scope = resolveScope(policy, { client });
  if (!scope.ok) return { ok: false, reason: "identity-rejected" };

  const coreClient = new CoreClient({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    serviceId: scope.identity.serviceId,
    isolation: {
      team_id: scope.identity.teamId,
      agent_id: scope.identity.agentId,
      user_id: scope.identity.userId,
      task_id: scope.identity.taskId,
    },
    timeoutMs: Math.min(config.timeouts.recallMs, Math.max(1, deadline - Date.now())),
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  return {
    ok: true,
    context: { config, identity: scope.identity, coreClient, dedupe: new TurnDedupe({ stateDir: join(RUNTIME_DIR, "state") }) },
  };
}

async function userPromptSubmit(client, input, deadline) {
  const sessionId = sourceSessionId(input);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const inspected = inspectTurn(prompt, "");
  const submittedAt = new Date().toISOString();
  const skip = inspected.skip;
  await savePendingTurn({
    client,
    sourceSessionId: sessionId,
    prompt: skip ? "" : inspected.user,
    skip,
    submittedAt
  }, { deadline });
  if (skip) return { output: {}, status: "opt-out" };

  const built = await buildContext(client, deadline);
  if (!built.ok) {
    // 身份/ACL 不合法：禁止召回（fail-closed），Agent 继续执行
    return { output: {}, status: built.reason };
  }

  const startedAt = Date.now();
  try {
    const { block, stats, degraded } = await recallMemory({
      client: built.context.coreClient,
      identity: built.context.identity,
      query: inspected.user,
      policy: built.context.config.recall,
    });
    observability.recordRecall({ client, ok: true, layers: stats, chars: stats.chars, elapsedMs: Date.now() - startedAt, degraded });
    if (!block) return { output: {}, status: "recall-empty" };
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: block
        }
      },
      status: "recalled"
    };
  } catch (error) {
    // Core 不可用/慢：fail-open，不拖住 Agent
    observability.recordRecall({ client, ok: false, errorClass: errorClass(error), elapsedMs: Date.now() - startedAt, degraded: ["all"] });
    return { output: {}, status: "recall-failed" };
  }
}

async function stop(client, input, deadline) {
  const sessionId = sourceSessionId(input);
  const pending = await takePendingTurn({ client, sourceSessionId: sessionId }, { consume: false, deadline });
  if (pending?.skip) return { output: {}, status: "opt-out" };

  const built = await buildContext(client, deadline);
  if (!built.ok) {
    // 身份/ACL 不合法：禁止召回（fail-closed），Agent 继续执行
    if (pending && !pending.skip && built.reason === "config-error") {
      // 配置缺失/损坏（非身份问题）：回合入 durable spool，待配置恢复后重试
      const inspectedFallback = inspectTurn(
        pending.prompt,
        typeof input.last_assistant_message === "string" ? input.last_assistant_message : "",
      );
      if (!inspectedFallback.skip) {
        const { memorySessionIdFor } = await import("./dedupe.mjs");
        await enqueueCapture({
          memorySessionId: memorySessionIdFor(client, sessionId),
          messages: [
            { role: "user", content: inspectedFallback.user, timestamp: pending.submittedAt },
            { role: "assistant", content: inspectedFallback.assistant, timestamp: new Date().toISOString() },
          ],
        }, { runtimeDir: RUNTIME_DIR, deadline });
        return { output: {}, status: "queued-config-error" };
      }
    }
    return { output: {}, status: built.reason };
  }

  const { context } = built;
  let capture = { status: "skipped" };
  if (pending && !pending.skip) {
    capture = await captureTurn({
      client: context.coreClient,
      identity: context.identity,
      dedupe: context.dedupe,
      observability,
      turn: {
        client,
        provider: "hook",
        sessionId,
        turnId: pending.submittedAt,
        originalUser: pending.prompt,
        finalAssistant: typeof input.last_assistant_message === "string" ? input.last_assistant_message : "",
        status: "completed",
      },
    });

    // 发送前失败（retryable）→ 入本地队列稍后重试（读回校验仍由 dedupe 把关）
    if (capture.status === "retryable") {
      await enqueueCapture({
        memorySessionId: capture.sessionId,
        messages: capture.messages,
        turnKey: capture.key,
      }, { runtimeDir: RUNTIME_DIR, deadline });
    }
  }

  const retry = deadline - Date.now() >= RETRY_START_RESERVE_MS
    ? await retryQueuedCaptures({
        coreClient: context.coreClient,
        dedupe: context.dedupe,
        retryBatchSize: context.config.queue.retryBatchSize,
        retryBudgetMs: Math.min(context.config.queue.retryBudgetMs, 800),
        runtimeDir: RUNTIME_DIR,
        deadline,
      })
    : { budgetExceeded: deadline <= Date.now(), processed: [] };

  const captureStatus = ["acknowledged", "duplicate"].includes(capture.status)
    ? "captured"
    : capture.status === "unknown"
      ? "unknown-ack"
      : capture.status === "queued"
        ? "queued"
        : capture.status;
  return {
    output: {},
    status: retry.budgetExceeded ? `${captureStatus}-retry-timeout` : captureStatus
  };
}

async function handle(client, input, deadline) {
  if (!CLIENTS.has(client)) return { output: {}, status: "invalid-client" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { output: {}, status: "invalid-input" };
  }
  if (sourceSessionId(input) === "") return { output: {}, status: "invalid-session" };
  if (input.hook_event_name === "UserPromptSubmit") return userPromptSubmit(client, input, deadline);
  if (input.hook_event_name === "Stop") return stop(client, input, deadline);
  return { output: {}, status: "unknown-event" };
}

let output = {};
let client = typeof process.argv[2] === "string" ? process.argv[2].toLowerCase() : "";
let event = "unknown";
let session = "none";
let status = "error";
let caughtError = null;

try {
  const input = JSON.parse(await readInputLine());
  event = eventName(input?.hook_event_name);
  session = sessionDigest(sourceSessionId(input));
  const result = await handle(client, input, WORK_DEADLINE);
  output = result.output;
  status = result.status;
} catch (error) {
  caughtError = error;
} finally {
  await writeStatus({ client, event, session, status, error: caughtError });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
