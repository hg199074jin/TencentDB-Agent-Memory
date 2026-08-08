import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  drainCaptureQueue,
  enqueueCapture,
  makeMemorySessionId,
  savePendingTurn,
  takePendingTurn
} from "../src/state-store.mjs";

const adapterDir = resolve(import.meta.dirname, "..");
const stateStoreUrl = pathToFileURL(join(adapterDir, "src", "state-store.mjs")).href;

async function withRuntime(run) {
  const runtimeRoot = join(adapterDir, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeDir = await mkdtemp(join(runtimeRoot, "test-"));
  try {
    await run(runtimeDir);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function captureRecord(content, timestamp = "2026-08-08T00:00:00.000Z") {
  return {
    memorySessionId: "codex-0123456789abcdef01234567",
    messages: [
      { role: "user", content, timestamp },
      { role: "assistant", content: `reply:${content}`, timestamp: "2026-08-08T00:00:01.000Z" }
    ]
  };
}

function runChild(script, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

test("pending turns are isolated by client, use digest-only filenames, and are consumed once", async () => {
  await withRuntime(async (runtimeDir) => {
    const sourceSessionId = "shared session / 用户";
    const prompt = "原始 prompt with spaces";
    for (const client of ["codex", "claude", "zcode"]) {
      await savePendingTurn({ client, sourceSessionId, prompt: `${client}:${prompt}`, skip: false, submittedAt: "2026-08-08T00:00:00.000Z" }, { runtimeDir });
    }

    const names = await readdir(join(runtimeDir, "pending"));
    assert.equal(names.length, 3);
    for (const name of names) {
      assert.match(name, /^[a-f0-9]{64}\.json$/);
      assert.equal(name.includes("shared"), false);
      assert.equal(name.includes("prompt"), false);
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const pending = await takePendingTurn({ client, sourceSessionId }, { runtimeDir });
      assert.deepEqual(pending, {
        client,
        prompt: `${client}:${prompt}`,
        skip: false,
        submittedAt: "2026-08-08T00:00:00.000Z"
      });
      assert.equal(await takePendingTurn({ client, sourceSessionId }, { runtimeDir }), null);
    }
  });
});

test("makeMemorySessionId prefixes a normalized client and the first 24 SHA-256 hex characters", () => {
  const source = "用户原始 session id";
  const digest = createHash("sha256").update(source, "utf8").digest("hex").slice(0, 24);
  assert.equal(makeMemorySessionId("Codex", source), `codex-${digest}`);
  assert.equal(makeMemorySessionId("Claude", source), `claude-${digest}`);
  assert.notEqual(makeMemorySessionId("codex", source), makeMemorySessionId("zcode", source));
});

test("a later hook removes orphaned pending turns older than seven days", async () => {
  await withRuntime(async (runtimeDir) => {
    await savePendingTurn({ client: "codex", sourceSessionId: "old", prompt: "old prompt", skip: false, submittedAt: "2026-07-01T00:00:00.000Z" }, { runtimeDir });
    const [oldName] = await readdir(join(runtimeDir, "pending"));
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(runtimeDir, "pending", oldName), oldTime, oldTime);

    await savePendingTurn({ client: "codex", sourceSessionId: "new", prompt: "new prompt", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });

    assert.equal(await takePendingTurn({ client: "codex", sourceSessionId: "old" }, { runtimeDir }), null);
    assert.equal((await takePendingTurn({ client: "codex", sourceSessionId: "new" }, { runtimeDir })).prompt, "new prompt");
  });
});

test("enqueueCapture persists one JSON object per line without unrelated secrets", async () => {
  await withRuntime(async (runtimeDir) => {
    const queued = await enqueueCapture({
      ...captureRecord("filtered user text"),
      apiKey: "must-not-be-written",
      callbackResult: { recalled: "must-not-be-written" }
    }, { runtimeDir });

    assert.equal(queued, true);
    const source = await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8");
    const lines = source.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const saved = JSON.parse(lines[0]);
    assert.equal(saved.memorySessionId, "codex-0123456789abcdef01234567");
    assert.deepEqual(saved.messages, captureRecord("filtered user text").messages);
    assert.equal(source.includes("must-not-be-written"), false);
  });
});

test("concurrent hook processes append without overwriting either record", async () => {
  await withRuntime(async (runtimeDir) => {
    const gate = join(runtimeDir, "start.gate");
    const childScript = `
      import { access } from "node:fs/promises";
      import { enqueueCapture } from ${JSON.stringify(stateStoreUrl)};
      while (true) { try { await access(process.env.TEST_GATE); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
      await enqueueCapture({ memorySessionId: "codex-test", messages: [
        { role: "user", content: process.env.TEST_CONTENT, timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "reply", timestamp: "2026-08-08T00:00:01.000Z" }
      ] }, { runtimeDir: process.env.TEST_RUNTIME });
    `;
    const first = runChild(childScript, { TEST_RUNTIME: runtimeDir, TEST_GATE: gate, TEST_CONTENT: "first" });
    const second = runChild(childScript, { TEST_RUNTIME: runtimeDir, TEST_GATE: gate, TEST_CONTENT: "second" });
    await writeFile(gate, "go", "utf8");
    await Promise.all([first, second]);

    const lines = (await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).messages[0].content).sort(), ["first", "second"]);
  });
});

test("a later enqueue recovers a rebuild file retained after an atomic replace failure", async () => {
  await withRuntime(async (runtimeDir) => {
    const oldRecord = captureRecord("old");
    const retainedRecord = captureRecord("retained");
    await writeFile(join(runtimeDir, "capture-queue.jsonl"), `${JSON.stringify(oldRecord)}\n`, "utf8");
    await writeFile(
      join(runtimeDir, ".capture-queue-rebuild-crashed.tmp"),
      `${JSON.stringify(oldRecord)}\n${JSON.stringify(retainedRecord)}\n`,
      "utf8"
    );

    assert.equal(await enqueueCapture(captureRecord("new"), { runtimeDir }), true);

    const lines = (await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line).messages[0].content), ["old", "retained", "new"]);
    assert.equal((await readdir(runtimeDir)).some((name) => name.startsWith(".capture-queue-rebuild-")), false);
  });
});

test("queue overflow preserves old data, rejects the new record, and logs no content", async () => {
  await withRuntime(async (runtimeDir) => {
    await mkdir(runtimeDir, { recursive: true });
    const queuePath = join(runtimeDir, "capture-queue.jsonl");
    const oldLine = `${JSON.stringify({ old: "x".repeat(20 * 1024 * 1024 - 20) })}\n`;
    await writeFile(queuePath, oldLine, "utf8");
    const oldSize = (await stat(queuePath)).size;

    assert.equal(await enqueueCapture(captureRecord("private overflow content"), { runtimeDir }), false);
    assert.equal((await stat(queuePath)).size, oldSize);
    assert.equal((await readFile(queuePath, "utf8")).includes("private overflow content"), false);
    const runtimeFiles = await readdir(runtimeDir);
    const warningName = runtimeFiles.find((name) => name.endsWith(".log"));
    assert.ok(warningName);
    assert.equal((await readFile(join(runtimeDir, warningName), "utf8")).includes("private overflow content"), false);
  });
});

test("enqueueCapture reports false when it cannot create a durable spool file", async () => {
  await withRuntime(async (runtimeDir) => {
    const blockedRuntime = join(runtimeDir, "not-a-directory");
    await writeFile(blockedRuntime, "occupied", "utf8");

    assert.equal(
      await enqueueCapture(captureRecord("cannot be persisted"), { runtimeDir: blockedRuntime }),
      false
    );
  });
});

test("drainCaptureQueue removes successful oldest records and retains a failed record", async () => {
  await withRuntime(async (runtimeDir) => {
    for (const content of ["one", "two", "three"]) await enqueueCapture(captureRecord(content), { runtimeDir });
    const handled = [];
    const firstDrain = await drainCaptureQueue(2, async (record) => {
      handled.push(record.messages[0].content);
      return record.messages[0].content !== "two";
    }, { runtimeDir });
    assert.deepEqual(handled, ["one", "two"]);
    assert.deepEqual(firstDrain, { processed: 2, removed: 1, remaining: 2, stopped: true });

    const remaining = [];
    await drainCaptureQueue(3, async (record) => { remaining.push(record.messages[0].content); return true; }, { runtimeDir });
    assert.deepEqual(remaining, ["two", "three"]);
  });
});
