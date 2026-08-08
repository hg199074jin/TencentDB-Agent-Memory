import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { captureTurn, retryQueuedCaptures } from "./capture.mjs";
import { loadConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";
import { hasNoMemoryDirective } from "./privacy.mjs";
import { recallCrossSession } from "./recall.mjs";
import { savePendingTurn, takePendingTurn } from "./state-store.mjs";

const CLIENTS = new Set(["codex", "claude", "zcode"]);
const RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url));
const STATUS_LOG = join(RUNTIME_DIR, "logs", "status.jsonl");

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
  return typeof input?.session_id === "string" ? input.session_id : "";
}

async function userPromptSubmit(client, input) {
  const sessionId = sourceSessionId(input);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const skip = hasNoMemoryDirective(prompt);
  await savePendingTurn({
    client,
    sourceSessionId: sessionId,
    prompt,
    skip,
    submittedAt: new Date().toISOString()
  });
  if (skip) return { output: {}, status: "opt-out" };

  const config = await loadConfig();
  const additionalContext = await recallCrossSession(new GatewayClient(config), prompt, config.recall);
  if (!additionalContext) return { output: {}, status: "recall-empty" };
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    },
    status: "recalled"
  };
}

async function stop(client, input) {
  const sessionId = sourceSessionId(input);
  const pending = await takePendingTurn({ client, sourceSessionId: sessionId });
  let capture = { captured: false, queued: false, skipped: true };
  const captureCurrentTurn = (gatewayClient) => captureTurn({
    gatewayClient,
    client,
    sourceSessionId: sessionId,
    user: pending.prompt,
    assistant: typeof input.last_assistant_message === "string" ? input.last_assistant_message : "",
    submittedAt: pending.submittedAt,
    completedAt: new Date().toISOString(),
    runtimeDir: RUNTIME_DIR
  });

  let config;
  let gatewayClient;
  try {
    config = await loadConfig();
    gatewayClient = new GatewayClient(config);
  } catch {
    if (pending && !pending.skip) {
      capture = await captureCurrentTurn({
        addConversation: async () => { throw new Error("Gateway unavailable"); }
      });
    }
    return { output: {}, status: capture.queued ? "queued" : "skipped" };
  }

  if (pending && !pending.skip) {
    capture = await captureCurrentTurn(gatewayClient);
  }
  const retry = await retryQueuedCaptures({
    gatewayClient,
    retryBatchSize: config.queue.retryBatchSize,
    retryBudgetMs: Math.min(config.queue.retryBudgetMs, 800),
    runtimeDir: RUNTIME_DIR
  });
  const captureStatus = capture.captured ? "captured" : capture.queued ? "queued" : "skipped";
  return {
    output: {},
    status: retry.budgetExceeded ? `${captureStatus}-retry-timeout` : captureStatus
  };
}

async function handle(client, input) {
  if (!CLIENTS.has(client)) return { output: {}, status: "invalid-client" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { output: {}, status: "invalid-input" };
  }
  if (input.hook_event_name === "UserPromptSubmit") return userPromptSubmit(client, input);
  if (input.hook_event_name === "Stop") return stop(client, input);
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
  const result = await handle(client, input);
  output = result.output;
  status = result.status;
} catch (error) {
  caughtError = error;
} finally {
  await writeStatus({ client, event, session, status, error: caughtError });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
