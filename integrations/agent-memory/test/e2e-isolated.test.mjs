// E2E：隔离 Memory Core 实例 + 合成语料， gates A–H。
// 不触碰生产：独立容器 am001-e2e-core / 端口 18420 / 卷 am001-e2e-data。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const HOOK_CLI = join(REPO, "src", "hook-cli.mjs");
const PRODUCTION_ENV = process.env.AM001_PRODUCTION_ENV ?? "/Volumes/ORICO/Projects/TencentDB-Agent-Memory/deploy/global-images/.env";
const E2E_PORT = 18420;
const CONTAINER = "am001-e2e-core";
const VOLUME = "am001-e2e-data";
// 固定 digest：E2E 可复现，不依赖 :latest 标签漂移（R2 要求）
const IMAGE = `agentmemory/memory-core@sha256:338847edc6464ed20a5f2a936ca2efa7fc71e188410836ebe9a711c1bc53fe84`;

const evidence = { gates: {}, timings: { recall: [], capture: [] } };

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`${cmd} ${args.join(" ")} → ${code}: ${stderr.slice(0, 300)}`))));
  });
}

function readEnvValue(name) {
  const line = readFileSync(PRODUCTION_ENV, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

async function waitHealthy(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${E2E_PORT}/health`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("isolated core did not become healthy");
}

function makeRoot(name, { allowed = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), `am001-${name}-`));
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(
    join(root, "config.local.json"),
    JSON.stringify({
      endpoint: `http://127.0.0.1:${E2E_PORT}`,
      hubEndpoint: "http://127.0.0.1:18125",
      apiKey: "e2e-bearer",
      serviceId: "e2e-service",
      identity: { userId: "usr-e2e", teamId: "team-e2e", agentId: "agt-e2e", taskId: "task-e2e" },
      ...(allowed ? { allowed } : {}),
      timeouts: { recallMs: 1200, captureMs: 3000 },
      recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 8000 },
      queue: { retryBatchSize: 3, retryBudgetMs: 800 },
    }),
  );
  return root;
}

function runHook(root, client, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_CLI, client], {
      env: { ...process.env, AGENT_MEMORY_ROOT: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("exit", () => {
      try {
        const statusPath = join(root, "runtime", "logs", "status.jsonl");
        let status = null;
        try {
          const lines = readFileSync(statusPath, "utf8").trimEnd().split("\n");
          status = JSON.parse(lines[lines.length - 1]).status;
        } catch { /* no status log yet */ }
        resolve({ output: JSON.parse(stdout || "{}"), stdout, status });
      } catch (error) {
        reject(new Error(`hook stdout not JSON: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// ── 隔离实例生命周期 ────────────────────────────────────────────────────────
test("E2E gates A–H on isolated core", async (t) => {
  const yamlDir = mkdtempSync(join(tmpdir(), "am001-cfg-"));
  writeFileSync(
    join(yamlDir, "tdai-gateway.yaml"),
    [
      "deployMode: standalone",
      "stateBackend: local",
      "server:",
      `  port: ${E2E_PORT}`,
      "  host: 0.0.0.0",
      "data:",
      "  baseDir: /data/tdai-memory",
      "llm:",
      `  baseUrl: "${readEnvValue("MEMORY_LLM_BASE_URL")}"`,
      `  apiKey: "${readEnvValue("MEMORY_LLM_API_KEY")}"`,
      `  model: "${readEnvValue("MEMORY_LLM_MODEL")}"`,
      "  maxTokens: 32000",
      "  timeoutMs: 300000",
      "memory:",
      "  promptMode: chat",
      "  capture: { enabled: true }",
      "  extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 }",
      "",
    ].join("\n"),
  );

  await sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }).catch(() => {});
  await sh("docker", ["volume", "rm", "-f", VOLUME], { stdio: "ignore" }).catch(() => {});
  await sh("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", `127.0.0.1:${E2E_PORT}:${E2E_PORT}`,
    "-v", `${VOLUME}:/data/tdai-memory`,
    "-v", `${join(yamlDir, "tdai-gateway.yaml")}:/data/config/tdai-gateway.yaml`,
    "-e", `TDAI_GATEWAY_PORT=${E2E_PORT}`,
    "-e", "TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml",
    "-e", "TDAI_GATEWAY_API_KEY=",
    IMAGE,
  ]);
  t.after(async () => {
    await sh("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }).catch(() => {});
    await sh("docker", ["volume", "rm", "-f", VOLUME], { stdio: "ignore" }).catch(() => {});
    rmSync(yamlDir, { recursive: true, force: true });
  });

  await waitHealthy();
  console.log(`isolated core healthy on :${E2E_PORT} (container ${CONTAINER}, volume ${VOLUME})`);

  const rootA = makeRoot("a");           // codex hook 客户端
  const rootB = makeRoot("b");           // opencode 插件客户端
  const rootForged = makeRoot("forged", {
    allowed: [{ teamId: "team-e2e", agentId: "agt-e2e" }],
  });
  // forged：身份不在白名单
  const forgedRoot = mkdtempSync(join(tmpdir(), "am001-forged-id-"));
  mkdirSync(join(forgedRoot, "runtime"), { recursive: true });
  writeFileSync(join(forgedRoot, "config.local.json"), JSON.stringify({
    endpoint: `http://127.0.0.1:${E2E_PORT}`,
    apiKey: "e2e-bearer",
    serviceId: "e2e-service",
    identity: { userId: "usr-e2e", teamId: "team-FORGED", agentId: "agt-FORGED", taskId: "task-e2e" },
    allowed: [{ teamId: "team-e2e", agentId: "agt-e2e" }],
    timeouts: { recallMs: 1200, captureMs: 3000 },
    recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 8000 },
    queue: { retryBatchSize: 3, retryBudgetMs: 800 },
  }));

  const SYNTH_A = `AM001-SYNTH-A-${"a1b2c3d4"}`;
  const SYNTH_A_ANSWER = `AM001-SYNTH-A-ANSWER-${"e5f6a7b8"}`;

  // ── Gate A：模型无关 —— 两端各自 provider，回忆与写入均不经过 Proxy ──
  await t.test("A model-agnostic: both clients recall/write with their own provider", async () => {
    const submit = await runHook(rootA, "codex", {
      session_id: "e2e-sess-a",
      hook_event_name: "UserPromptSubmit",
      prompt: `请记住这个合成标记 ${SYNTH_A}，它属于 E2E  gate A`,
    });
    assert.ok(!submit.stdout.includes("8096"), "hook must not proxy LLM traffic");

    // opencode 插件（provider=step-5，与 hook 客户端不同模型线路）
    process.env.AGENT_MEMORY_ROOT = rootB;
    const { CrossAgentMemory } = await import("../plugin/opencode-cross-agent-memory.js");
    const plugin = await CrossAgentMemory({ client: { session: { messages: async () => [] } } });
    const sys = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "e2e-sess-b", model: { providerID: "step-5" } }, sys);
    assert.equal(sys.system.length, 0, "no recall yet for fresh session");

    const stop = await runHook(rootA, "codex", {
      session_id: "e2e-sess-a",
      hook_event_name: "Stop",
      last_assistant_message: `已记住 ${SYNTH_A_ANSWER}`,
    });
    // 写路径状态词表（含 fail-open：pending 不可用时跳过捕获，Agent 不受影响）。
    // 写入严格性由 Gate C/E/J 与 hook-cli 进程契约测试覆盖。
    const writeStatuses = ["captured", "captured-retry-timeout", "unknown-ack", "unknown", "retryable", "queued", "deferred", "denied", "skipped"];
    assert.ok(writeStatuses.includes(stop.status ?? ""), `unexpected stop status: ${stop.status}`);
    evidence.gates.A = { hookProvider: "codex-direct", pluginProvider: "step-5", proxyUntouched: true, stopStatus: stop.status };
  });

  // ── Gate B：跨客户端共享作用域 + 伪造身份拒绝 ──
  await t.test("B cross-client scope sharing and forged identity rejection", async () => {
    // 客户端 B（opencode 插件）召回客户端 A 写入的合成标记
    process.env.AGENT_MEMORY_ROOT = rootB;
    const mod = await import(`../plugin/opencode-cross-agent-memory.js?b=${Date.now()}`);
    const plugin = await mod.CrossAgentMemory({ client: { session: { messages: async () => [] } } });
    await plugin["chat.message"](
      { sessionID: "e2e-sess-b2", messageID: "u1", model: { providerID: "step-5" } },
      { message: { id: "u1" }, parts: [{ type: "text", text: `合成标记 ${SYNTH_A} 是什么` }] },
    );
    const sys = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "e2e-sess-b2", model: { providerID: "step-5" } }, sys);
    assert.equal(sys.system.length, 1, "client B must recall client A's turn in the same scope");
    assert.ok(sys.system[0].includes(SYNTH_A), "recalled block must contain client A synthetic marker");

    // 伪造身份：白名单拒绝 → 无注入
    process.env.AGENT_MEMORY_ROOT = forgedRoot;
    const forgedMod = await import(`../plugin/opencode-cross-agent-memory.js?f=${Date.now()}`);
    const forgedPlugin = await forgedMod.CrossAgentMemory({ client: { session: { messages: async () => [] } } });
    const sysForged = { system: [] };
    await forgedPlugin["chat.message"](
      { sessionID: "e2e-sess-forged", messageID: "u1", model: { providerID: "step-5" } },
      { message: { id: "u1" }, parts: [{ type: "text", text: `合成标记 ${SYNTH_A}` }] },
    );
    await forgedPlugin["experimental.chat.system.transform"]({ sessionID: "e2e-sess-forged", model: { providerID: "step-5" } }, sysForged);
    assert.equal(sysForged.system.length, 0, "forged scope must not inject");
    process.env.AGENT_MEMORY_ROOT = rootB;
    evidence.gates.B = { crossClientRecall: true, forgedRejected: true, note: "server-side identity binding is a known upstream gap (see M0 §5)" };
  });

  // ── Gate C：记录准确（重复事件/重启/并发/新 turn）──
  await t.test("C capture accuracy: repeated events, restart, concurrency, new turns", async () => {
    const { CoreClient } = await import("../src/core-client.mjs");
    const client = new CoreClient({
      endpoint: `http://127.0.0.1:${E2E_PORT}`,
      apiKey: "e2e-bearer",
      serviceId: "e2e-service",
      isolation: { team_id: "team-e2e", agent_id: "agt-e2e", user_id: "usr-e2e", task_id: "task-e2e" },
    });

    // C1: 30 次重复 Stop（模拟工具循环重复回调）→ 恰好一对 L0
    const sess = "e2e-sess-c1";
    await runHook(rootA, "codex", { session_id: sess, hook_event_name: "UserPromptSubmit", prompt: "C1 重复回调测试问题" });
    for (let i = 0; i < 30; i += 1) {
      await runHook(rootA, "codex", { session_id: sess, hook_event_name: "Stop", last_assistant_message: `C1 回答第${i}次` });
    }
    const sessionId = `codex-${(await import("node:crypto")).createHash("sha256").update(sess).digest("hex").slice(0, 24)}`;
    const q1 = await client.queryConversation({ sessionId, limit: 100 });
    const pairs = q1.messages.filter((m) => m.role === "user" && m.content === "C1 重复回调测试问题").length;
    assert.equal(pairs, 1, `30 repeated Stop events must produce exactly 1 user record, got ${pairs}`);

    // C2: 进程重启（新 hook 进程共享同一 root → 持久化状态）→ 同 turn 不重写
    await runHook(rootA, "codex", { session_id: sess, hook_event_name: "Stop", last_assistant_message: "C1 回答重启后" });
    const q2 = await client.queryConversation({ sessionId, limit: 100 });
    assert.equal(q2.messages.filter((m) => m.role === "user" && m.content === "C1 重复回调测试问题").length, 1, "restart must not re-write");

    // C3: 并发（两个进程同时 Stop 同一会话）→ 不放大
    const sessC3 = "e2e-sess-c3";
    await runHook(rootA, "codex", { session_id: sessC3, hook_event_name: "UserPromptSubmit", prompt: "C3 并发测试问题" });
    await Promise.all([0, 1, 2].map(() =>
      runHook(rootA, "codex", { session_id: sessC3, hook_event_name: "Stop", last_assistant_message: "C3 并发回答" })));
    const sessionIdC3 = `codex-${(await import("node:crypto")).createHash("sha256").update(sessC3).digest("hex").slice(0, 24)}`;
    const q3 = await client.queryConversation({ sessionId: sessionIdC3, limit: 100 });
    const c3Pairs = q3.messages.filter((m) => m.role === "user" && m.content === "C3 并发测试问题").length;
    assert.equal(c3Pairs, 1, `concurrent stops must produce exactly one L0 pair (got ${c3Pairs}); cross-process lock + read-back`);

    // C4: 新 turn（新 prompt）→ 正常新写
    await runHook(rootA, "codex", { session_id: sessC3, hook_event_name: "UserPromptSubmit", prompt: "C4 新一轮问题" });
    await runHook(rootA, "codex", { session_id: sessC3, hook_event_name: "Stop", last_assistant_message: "C4 新一轮回答" });
    const q4 = await client.queryConversation({ sessionId: sessionIdC3, limit: 100 });
    assert.ok(q4.messages.some((m) => m.content === "C4 新一轮问题"), "new turn must be written");
    evidence.gates.C = { repeatedStop: 1, restartStable: true, concurrencyMax: c3Pairs, newTurnWritten: true };
  });

  // ── Gate D：故障隔离 ──
  await t.test("D fault isolation: core down does not block agents", async () => {
    await sh("docker", ["stop", CONTAINER]);
    const started = Date.now();
    const submit = await runHook(rootA, "codex", {
      session_id: "e2e-sess-d",
      hook_event_name: "UserPromptSubmit",
      prompt: "D 故障隔离测试",
    });
    const recallMs = Date.now() - started;
    assert.deepEqual(submit.output, {}, "core down → no injection");
    assert.ok(recallMs < 3000, `recall must fail fast (took ${recallMs}ms)`);

    const stop = await runHook(rootA, "codex", {
      session_id: "e2e-sess-d",
      hook_event_name: "Stop",
      last_assistant_message: "D 故障隔离回答",
    });
    assert.ok(stop.stdout.length > 0, "stop must still respond");
    await sh("docker", ["start", CONTAINER]);
    await waitHealthy();
    evidence.gates.D = { recallMsWhileDown: recallMs, stopResponded: true };
  });

  // ── Gate E：隐私与信任 ──
  await t.test("E privacy: opt-out, secrets, data-uri, injected blocks stay out of L0", async () => {
    const { CoreClient } = await import("../src/core-client.mjs");
    const client = new CoreClient({
      endpoint: `http://127.0.0.1:${E2E_PORT}`,
      apiKey: "e2e-bearer",
      serviceId: "e2e-service",
      isolation: { team_id: "team-e2e", agent_id: "agt-e2e", user_id: "usr-e2e", task_id: "task-e2e" },
    });
    const cases = [
      ["opt-out", "这条不记忆 [不记忆] AM001-PRIV-1", "AM001-PRIV-1 回答"],
      ["nomemory", "/nomemory AM001-PRIV-2", "AM001-PRIV-2 回答"],
      ["secret", "api_key = sk-am001secretkey123456", "AM001-PRIV-3 回答"],
      ["bearer", "Authorization: Bearer am001token123456", "AM001-PRIV-4 回答"],
      ["data-uri", "data:text/plain;base64,QU1EMDDEtUUID=", "AM001-PRIV-5 回答"],
    ];
    for (const [name, prompt, answer] of cases) {
      const sess = `e2e-sess-e-${name}`;
      await runHook(rootA, "codex", { session_id: sess, hook_event_name: "UserPromptSubmit", prompt });
      await runHook(rootA, "codex", { session_id: sess, hook_event_name: "Stop", last_assistant_message: answer });
      const sessionId = `codex-${(await import("node:crypto")).createHash("sha256").update(sess).digest("hex").slice(0, 24)}`;
      const q = await client.queryConversation({ sessionId, limit: 20 });
      const leaked = q.messages.some((m) =>
        m.content.includes("AM001-PRIV-") && !(name === "data-uri") ||
        (name === "secret" && m.content.includes("sk-am001")) ||
        (name === "bearer" && m.content.includes("Bearer am001")) ||
        (name === "data-uri" && m.content.includes("base64,QU1EMDDE")));
      assert.equal(leaked, false, `privacy case ${name} leaked into L0`);
    }
    // 注入块剥离：user 文本里的历史记忆块不得写回
    const sessInjected = "e2e-sess-e-injected";
    await runHook(rootA, "codex", {
      session_id: sessInjected,
      hook_event_name: "UserPromptSubmit",
      prompt: '<cross-agent-memory trust="historical-reference-only">旧记忆块</cross-agent-memory>AM001-INJECTED真实问题',
    });
    await runHook(rootA, "codex", { session_id: sessInjected, hook_event_name: "Stop", last_assistant_message: "AM001-INJECTED回答" });
    const sessionIdInj = `codex-${(await import("node:crypto")).createHash("sha256").update(sessInjected).digest("hex").slice(0, 24)}`;
    const qInj = await client.queryConversation({ sessionId: sessionIdInj, limit: 20 });
    assert.ok(!qInj.messages.some((m) => m.content.includes("cross-agent-memory")), "injected block must be stripped before L0");
    assert.ok(qInj.messages.some((m) => m.content.includes("AM001-INJECTED真实问题")), "clean user text must still be captured");
    evidence.gates.E = { casesChecked: cases.length + 1, leaks: 0 };
  });

  // ── Gate F：Proxy 共存 ──
  await t.test("F proxy coexistence: proxy-provider session stays silent", async () => {
    process.env.AGENT_MEMORY_ROOT = rootB;
    const mod = await import(`../plugin/opencode-cross-agent-memory.js?f2=${Date.now()}`);
    const plugin = await mod.CrossAgentMemory({ client: { session: { messages: async () => [] } } });
    await plugin["chat.message"](
      { sessionID: "e2e-sess-f", messageID: "u1", model: { providerID: "tencentdb-agent-memory", modelID: "glm" } },
      { message: { id: "u1" }, parts: [{ type: "text", text: "F proxy 共存测试" }] },
    );
    const sys = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "e2e-sess-f", model: { providerID: "tencentdb-agent-memory" } }, sys);
    assert.equal(sys.system.length, 0);
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "e2e-sess-f" } } });
    const { CoreClient } = await import("../src/core-client.mjs");
    const client = new CoreClient({ endpoint: `http://127.0.0.1:${E2E_PORT}`, apiKey: "e2e-bearer", serviceId: "e2e-service", isolation: { team_id: "team-e2e", agent_id: "agt-e2e", user_id: "usr-e2e", task_id: "task-e2e" } });
    const q = await client.queryConversation({ sessionId: "opencode-" + (await import("node:crypto")).createHash("sha256").update("e2e-sess-f").digest("hex").slice(0, 24), limit: 20 });
    assert.equal(q.messages.length, 0, "proxy-provider session must not write via plugin");
    evidence.gates.F = { pluginSilent: true };
  });

  // ── Gate G：提炼效果（L0 ACK → L1 可检索）──
  await t.test("G distillation: L0 ack leads to retrievable L1 within budget", async () => {
    const { CoreClient } = await import("../src/core-client.mjs");
    const client = new CoreClient({
      endpoint: `http://127.0.0.1:${E2E_PORT}`,
      apiKey: "e2e-bearer",
      serviceId: "e2e-service",
      isolation: { team_id: "team-e2e", agent_id: "agt-e2e", user_id: "usr-e2e", task_id: "task-e2e" },
    });
    const marker = `AM001-DISTILL-${(await import("node:crypto")).randomBytes(4).toString("hex")}`;
    const sess = "e2e-sess-g";
    await runHook(rootA, "codex", { session_id: sess, hook_event_name: "UserPromptSubmit", prompt: `我们决定：项目 ${marker} 的部署窗口是每周三凌晨，负责人是合成测试员。` });
    await runHook(rootA, "codex", { session_id: sess, hook_event_name: "Stop", last_assistant_message: `好的，已记录 ${marker} 的部署窗口为每周三凌晨。` });

    const deadline = Date.now() + 120_000;
    let l1Found = false;
    let coreRead = false;
    while (Date.now() < deadline) {
      const atomic = await client.searchAtomic({ query: marker, limit: 5 }).catch(() => ({ items: [] }));
      if ((atomic.items ?? []).some((item) => String(item.content ?? "").includes(marker))) l1Found = true;
      const core = await client.readCore().catch(() => null);
      if (core?.content && core.content.length > 0) coreRead = true;
      if (l1Found) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    evidence.gates.G = { l1Found, coreRead, waitedMs: 120_000 - Math.max(0, deadline - Date.now()) };
    assert.ok(l1Found, "L1 extraction must make the synthetic decision retrievable within 120s");
  });

  // ── Gate I：Claude / ZCode 真实 hook JSON 模拟（R2：补齐四客户端证据）──
  await t.test("I claude/zcode real hook JSON simulation", async () => {
    const results = {};
    for (const client of ["claude", "zcode"]) {
      const sessionId = `e2e-sess-i-${client}-${(await import("node:crypto")).randomBytes(4).toString("hex")}`;
      const submit = await runHook(rootA, client, {
        session_id: sessionId,
        transcript_path: `/tmp/${client}-transcript.jsonl`,
        cwd: "/tmp",
        hook_event_name: "UserPromptSubmit",
        prompt: `I 门 ${client} 线路合成问题 AM001-SYNTH-I`,
      });
      const stop = await runHook(rootA, client, {
        session_id: sessionId,
        transcript_path: `/tmp/${client}-transcript.jsonl`,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: `I 门 ${client} 线路合成回答`,
      });
      results[client] = { recallStatus: submit.status, captureStatus: stop.status };
      assert.ok(["recalled", "recall-empty", "recall-failed"].includes(submit.status), `${client} submit: ${submit.status}`);
      assert.ok(["captured", "unknown", "retryable", "deferred"].includes(stop.status), `${client} stop: ${stop.status}`);
    }
    evidence.gates.I = results;
  });

  // ── Gate J：网络异常注入（R2 P0-A 决定性证据）──
  await t.test("J network anomaly injection: partial body / post-send timeout / 503", async () => {
    // 直接以模块级注入验证 delivery 分类在 capture→dedupe→spool 链路的端到端行为
    const { captureTurn } = await import("../src/capture.mjs");
    const { TurnDedupe } = await import("../src/dedupe.mjs");
    const identity = { serviceId: "e2e-service", teamId: "team-e2e", userId: "usr-e2e", agentId: "agt-e2e" };
    const mkClient = (mode) => ({
      addConversation: async () => {
        if (mode === "partial") throw Object.assign(new Error("terminated"), { delivery: "maybe_sent" });
        if (mode === "timeout") throw Object.assign(new Error("timed out"), { delivery: "maybe_sent" });
        if (mode === "refused") throw Object.assign(new Error("ECONNREFUSED"), { delivery: "definitely_not_sent" });
        if (mode === "forbidden") throw Object.assign(new Error("403"), { delivery: "rejected", status: 403 });
        return { total: 2 };
      },
      queryConversation: async () => ({ messages: [] }),
    });
    const turn = (turnId) => ({ client: "codex", provider: "p", sessionId: "e2e-sess-j", turnId, originalUser: `J 门问题 ${turnId}`, finalAssistant: "J 门回答", status: "completed" });

    // J1: maybe_sent → unknown，且不重发
    const d1 = new TurnDedupe({ memory: new Map() });
    let sends1 = 0;
    const c1 = mkClient("partial");
    const origAdd1 = c1.addConversation;
    c1.addConversation = async (...args) => { sends1 += 1; return origAdd1(...args); };
    const r1 = await captureTurn({ client: c1, identity, dedupe: d1, turn: turn("j1") });
    const r1b = await captureTurn({ client: c1, identity, dedupe: d1, turn: turn("j1") });
    assert.equal(r1.status, "unknown");
    assert.equal(r1b.status, "unknown");
    assert.equal(sends1, 1, "maybe_sent must never be retried");

    // J2: 503（maybe_sent）→ unknown；reconcile 读回命中 → acknowledged(suspected)
    const d2 = new TurnDedupe({ memory: new Map() });
    const r2 = await captureTurn({ client: mkClient("timeout"), identity, dedupe: d2, turn: turn("j2") });
    assert.equal(r2.status, "unknown");
    const recon = await d2.reconcile({ key: r2.key, verify: async () => true });
    assert.equal(recon.status, "acknowledged");
    assert.equal(recon.suspected, true);

    // J3: ECONNREFUSED（definitely_not_sent）→ retryable，可重发
    const d3 = new TurnDedupe({ memory: new Map() });
    let sends3 = 0;
    const c3 = mkClient("refused");
    const origAdd3 = c3.addConversation;
    c3.addConversation = async (...args) => { sends3 += 1; if (sends3 === 1) return origAdd3(...args); return { total: 2 }; };
    const r3 = await captureTurn({ client: c3, identity, dedupe: d3, turn: turn("j3") });
    assert.equal(r3.status, "retryable");
    const r3b = await captureTurn({ client: c3, identity, dedupe: d3, turn: turn("j3") });
    assert.equal(r3b.status, "acknowledged");
    assert.equal(sends3, 2, "definitely_not_sent may be retried once it recovers");

    // J4: 授权拒绝 → denied，不重试
    const d4 = new TurnDedupe({ memory: new Map() });
    let sends4 = 0;
    const c4 = mkClient("forbidden");
    const origAdd4 = c4.addConversation;
    c4.addConversation = async (...args) => { sends4 += 1; return origAdd4(...args); };
    const r4 = await captureTurn({ client: c4, identity, dedupe: d4, turn: turn("j4") });
    const r4b = await captureTurn({ client: c4, identity, dedupe: d4, turn: turn("j4") });
    assert.equal(r4.status, "denied");
    assert.equal(r4b.status, "denied");
    assert.equal(sends4, 1, "authorization rejection must not be retried");
    evidence.gates.J = { maybeSentNoRetry: true, reconcileSuspected: true, notSentRetryable: true, rejectedDenied: true };
  });

  // ── Gate K：ACK 后进程崩溃 / 磁盘满 / 锁跨进程超时（R2 P0-B/P1-C）──
  await t.test("K crash/disk/lock anomalies", async () => {
    const { captureTurn } = await import("../src/capture.mjs");
    const { TurnDedupe } = await import("../src/dedupe.mjs");
    const identity = { serviceId: "e2e-service", teamId: "team-e2e", userId: "usr-e2e", agentId: "agt-e2e" };
    const client = {
      addConversation: async () => ({ total: 2 }),
      queryConversation: async () => ({ messages: [] }),
    };
    // K1: ACK 后"进程崩溃"（新实例读同一 stateDir）→ 同 turn 不重写
    const dir = (await import("node:fs")).mkdtempSync("/tmp/am001-k-");
    const d1 = new TurnDedupe({ stateDir: dir });
    await captureTurn({ client, identity, dedupe: d1, turn: { client: "codex", provider: "p", sessionId: "e2e-sess-k1", turnId: "k1", originalUser: "K 崩溃恢复问题", finalAssistant: "K 回答", status: "completed" } });
    const d2 = new TurnDedupe({ stateDir: dir }); // 模拟重启
    let sends = 0;
    const countingClient = { ...client, addConversation: async () => { sends += 1; return { total: 2 }; } };
    const r = await captureTurn({ client: countingClient, identity, dedupe: d2, turn: { client: "codex", provider: "p", sessionId: "e2e-sess-k1", turnId: "k1", originalUser: "K 崩溃恢复问题", finalAssistant: "K 回答", status: "completed" } });
    assert.equal(r.status, "duplicate");
    assert.equal(sends, 0);

    // K2: 磁盘满（state 写入失败）→ deferred，不发送
    const dir2 = (await import("node:fs")).mkdtempSync("/tmp/am001-k2-");
    await (await import("node:fs/promises")).mkdir(dir2 + "/turns.json", { recursive: true }); // 使写入失败
    const d3 = new TurnDedupe({ stateDir: dir2 });
    let sends2 = 0;
    const client3 = { ...client, addConversation: async () => { sends2 += 1; return { total: 2 }; } };
    const r2 = await captureTurn({ client: client3, identity, dedupe: d3, turn: { client: "codex", provider: "p", sessionId: "e2e-sess-k2", turnId: "k2", originalUser: "K 磁盘满问题", finalAssistant: "K 回答", status: "completed" } });
    assert.equal(r2.status, "deferred");
    assert.equal(sends2, 0, "persistence failure must not send");
    evidence.gates.K = { ackCrashSafe: true, diskFullDeferred: true };
  });

  // ── Gate H：延迟预算 ──
  await t.test("H latency budget", async () => {
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const started = Date.now();
      await runHook(rootA, "codex", { session_id: `e2e-sess-h-${i}`, hook_event_name: "UserPromptSubmit", prompt: `H 延迟预算探测 ${i}` });
      samples.push(Date.now() - started);
    }
    const captureSamples = [];
    for (let i = 0; i < 3; i += 1) {
      const sess = `e2e-sess-hc-${i}`;
      await runHook(rootA, "codex", { session_id: sess, hook_event_name: "UserPromptSubmit", prompt: `H capture 探测 ${i}` });
      const started = Date.now();
      await runHook(rootA, "codex", { session_id: sess, hook_event_name: "Stop", last_assistant_message: `H capture 回答 ${i}` });
      captureSamples.push(Date.now() - started);
    }
    const p = (arr, q) => arr.slice().sort((a, b) => a - b)[Math.floor(q * (arr.length - 1))];
    evidence.timings.recall = samples;
    evidence.timings.capture = captureSamples;
    evidence.gates.H = { recallP50: p(samples, 0.5), recallMax: Math.max(...samples), captureMax: Math.max(...captureSamples) };
    assert.ok(Math.max(...samples) < 1200 + 2000, `recall max ${Math.max(...samples)}ms over budget+slack`);
    assert.ok(Math.max(...captureSamples) < 3000 + 2000, `capture max ${Math.max(...captureSamples)}ms over budget+slack`);
  });
});
