import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { enqueueCapture } from "../src/state-store.mjs";

const adapterDir = fileURLToPath(new URL("../", import.meta.url));
const hookCli = join(adapterDir, "src", "hook-cli.mjs");
const configPath = join(adapterDir, "config.local.json");
const runtimeDir = join(adapterDir, "runtime");

function envelope(data) {
  return JSON.stringify({ code: 0, message: "ok", request_id: randomUUID(), data });
}

async function readRequestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return JSON.parse(source);
}

async function startGateway() {
  const requests = [];
  const hangingResponses = new Set();
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ path: request.url, body });
    if (body.query === "hang request private prompt") {
      hangingResponses.add(response);
      response.on("close", () => hangingResponses.delete(response));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/v3/conversation/search") {
      response.end(envelope({ messages: [{ content: "历史参考内容" }] }));
    } else if (request.url === "/v3/atomic/search") {
      response.end(envelope({ items: [] }));
    } else if (request.url === "/v3/core/read") {
      response.end(envelope({ content: "" }));
    } else if (request.url === "/v3/conversation/query") {
      response.end(envelope({ messages: [] }));
    } else {
      response.end(envelope({ accepted: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      for (const response of hangingResponses) response.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runHook(client, input, timeoutMs = 4_500) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookCli, client], {
      cwd: dirname(hookCli),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook process exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let output;
      try {
        assert.equal(code, 0, `stderr: ${stderr}`);
        assert.equal(lines.length, 1, `stdout: ${stdout}`);
        output = JSON.parse(lines[0]);
        assert.equal(typeof output, "object");
        assert.notEqual(output, null);
        assert.equal(Array.isArray(output), false);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ output, stdout, stderr });
    });
    child.stdin.end(`${input}\n`);
  });
}

function isSharedRuntimeEntry(name) {
  return new Set([
    "capture-queue.jsonl",
    "capture-queue.lock",
    "capture-spool",
    "logs",
    "pending",
    "warnings.log"
  ]).has(name) || name.startsWith(".capture-queue-rebuild-");
}

async function isolateAdapterState() {
  await mkdir(runtimeDir, { recursive: true });
  const backupDir = join(runtimeDir, `.hook-cli-test-backup-${process.pid}-${randomUUID()}`);
  await mkdir(backupDir);
  for (const name of await readdir(runtimeDir)) {
    if (!isSharedRuntimeEntry(name)) continue;
    await rename(join(runtimeDir, name), join(backupDir, name));
  }
  try {
    await rename(configPath, join(backupDir, "config.local.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return async () => {
    for (const name of await readdir(runtimeDir)) {
      if (isSharedRuntimeEntry(name)) await rm(join(runtimeDir, name), { recursive: true, force: true });
    }
    try { await rm(configPath, { force: true }); } catch { /* Best effort cleanup. */ }
    for (const name of await readdir(backupDir)) {
      if (name === "config.local.json") await rename(join(backupDir, name), configPath);
      else await rename(join(backupDir, name), join(runtimeDir, name));
    }
    await rm(backupDir, { recursive: true, force: true });
  };
}

test("shared hook CLI preserves the three-client process contract and fails open without leaking content", async () => {
  const restore = await isolateAdapterState();
  const gateway = await startGateway();
  const privatePrompt = "please retain PRIVATE-PROMPT-7193";
  const privateAssistant = "PRIVATE-ASSISTANT-2841";
  const apiKey = "PRIVATE-API-KEY-6637";
  const stderrOutputs = [];
  const writeConfig = () => writeFile(configPath, JSON.stringify({
    endpoint: gateway.endpoint,
    apiKey,
    serviceId: "test-service",
    identity: {
      teamId: "test-team",
      agentId: "test-agent",
      userId: "test-user",
      taskId: "test-task"
    },
    timeouts: { recallMs: 1_000, captureMs: 1_000 },
    recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 2_000 },
    queue: { retryBatchSize: 3, retryBudgetMs: 800 }
  }), "utf8");

  try {
    await writeConfig();
    for (const client of ["codex", "claude", "zcode"]) {
      const sessionId = `${client}-${randomUUID()}`;
      const recalled = await runHook(client, JSON.stringify({
        session_id: sessionId,
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
        prompt: privatePrompt
      }));
      stderrOutputs.push(recalled.stderr);
      assert.equal(recalled.output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.match(recalled.output.hookSpecificOutput.additionalContext, /历史参考内容/);

      const stopped = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        stop_hook_active: false,
        transcript_path: "NEVER-READ-TRANSCRIPT-9912",
        last_assistant_message: privateAssistant
      }));
      stderrOutputs.push(stopped.stderr);
      assert.deepEqual(stopped.output, {});
      assert.equal(gateway.requests.some((item) => item.body.session_id?.startsWith(`${client}-`)), true);
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const before = gateway.requests.length;
      const sessionId = `${client}-opt-out-${randomUUID()}`;
      const submit = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "[不记忆] private opt-out prompt"
      }));
      const stop = await runHook(client, JSON.stringify({
        session_id: sessionId,
        hook_event_name: "Stop",
        last_assistant_message: "private opt-out answer"
      }));
      stderrOutputs.push(submit.stderr, stop.stderr);
      assert.deepEqual(submit.output, {});
      assert.deepEqual(stop.output, {});
      assert.equal(gateway.requests.length, before);
    }

    const orderedSession = `ordered-${randomUUID()}`;
    await runHook("codex", JSON.stringify({
      session_id: orderedSession,
      hook_event_name: "UserPromptSubmit",
      prompt: "current ordered prompt"
    }));
    await enqueueCapture({
      memorySessionId: "codex-seeded-old-record",
      messages: [
        { role: "user", content: "old queued prompt", timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "old queued answer", timestamp: "2026-08-08T00:00:01.000Z" }
      ]
    }, { runtimeDir });
    gateway.requests.length = 0;
    const orderedStop = await runHook("codex", JSON.stringify({
      session_id: orderedSession,
      hook_event_name: "Stop",
      last_assistant_message: "current ordered answer"
    }));
    assert.deepEqual(orderedStop.output, {});
    assert.deepEqual(gateway.requests.map((item) => item.path), [
      "/v3/conversation/add",
      "/v3/conversation/query",
      "/v3/conversation/add"
    ]);
    assert.equal(gateway.requests[0].body.messages[0].content, "current ordered prompt");
    assert.equal(gateway.requests[0].body.messages[1].content, "current ordered answer");
    assert.equal(gateway.requests[2].body.messages[0].content, "old queued prompt");

    const hangingStarted = Date.now();
    const hanging = await runHook("zcode", JSON.stringify({
      session_id: `hang-${randomUUID()}`,
      hook_event_name: "UserPromptSubmit",
      prompt: "hang request private prompt"
    }));
    stderrOutputs.push(hanging.stderr);
    assert.deepEqual(hanging.output, {});
    assert.ok(Date.now() - hangingStarted < 5_000);

    for (const [client, source] of [
      ["codex", "not JSON"],
      ["claude", JSON.stringify({ session_id: "unknown", hook_event_name: "UnknownEvent", prompt: privatePrompt })],
      ["invalid-client", JSON.stringify({ session_id: "invalid-client", hook_event_name: "UserPromptSubmit", prompt: privatePrompt })]
    ]) {
      const result = await runHook(client, source);
      stderrOutputs.push(result.stderr);
      assert.deepEqual(result.output, {});
    }

    await rm(configPath, { force: true });
    const missingConfig = await runHook("codex", JSON.stringify({
      session_id: "missing-config",
      hook_event_name: "UserPromptSubmit",
      prompt: privatePrompt
    }));
    stderrOutputs.push(missingConfig.stderr);
    assert.deepEqual(missingConfig.output, {});

    const logSource = await readFile(join(runtimeDir, "logs", "status.jsonl"), "utf8");
    const diagnostics = `${stderrOutputs.join("")}\n${logSource}`;
    for (const secret of [privatePrompt, privateAssistant, apiKey, "NEVER-READ-TRANSCRIPT-9912"]) {
      assert.equal(diagnostics.includes(secret), false);
    }
    for (const line of logSource.trim().split("\n")) {
      const record = JSON.parse(line);
      assert.deepEqual(Object.keys(record).sort(), [
        "client", "errorClass", "event", "session", "status", "timestamp"
      ]);
      assert.match(record.session, /^(?:[a-f0-9]{16}|none)$/);
    }
  } finally {
    await writeConfig().catch(() => {});
    await gateway.close();
    await restore();
  }
});
