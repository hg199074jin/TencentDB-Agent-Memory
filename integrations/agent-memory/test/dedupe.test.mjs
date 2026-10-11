// dedupe.mjs — turnKey 公式、状态机、持久化、未知 ACK（RED）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TurnDedupe, turnKey } from "../src/dedupe.mjs";

const SCOPE = {
  serviceId: "default",
  teamId: "team-t",
  userId: "usr-t",
  agentId: "agt-t",
  client: "codex",
  sessionId: "sess-1",
  turnId: "turn-1",
};

// D1: turnKey = H(service,team,user,agent,client,sessionId,turnId) —— 任一维度变化都变
{
  const base = turnKey(SCOPE);
  assert.match(base, /^[0-9a-f]{16,64}$/);
  const variants = {
    service: { ...SCOPE, serviceId: "other" },
    team: { ...SCOPE, teamId: "team-x" },
    user: { ...SCOPE, userId: "usr-x" },
    agent: { ...SCOPE, agentId: "agt-x" },
    client: { ...SCOPE, client: "zcode" },
    session: { ...SCOPE, sessionId: "sess-2" },
    turn: { ...SCOPE, turnId: "turn-2" },
  };
  for (const [name, scope] of Object.entries(variants)) {
    assert.notEqual(turnKey(scope), base, `${name} must change turnKey`);
  }
  console.log("D1 turnKey covers all identity dimensions: PASS");
}

// D2: 相同输入 → 稳定键（可复现）
{
  assert.equal(turnKey(SCOPE), turnKey({ ...SCOPE }));
  console.log("D2 turnKey stable: PASS");
}

// D3: 状态机 pending → sending → acknowledged；重复 execute 直接 acknowledged 不再发送
{
  const dedupe = new TurnDedupe({ memory: new Map() });
  let sends = 0;
  const op = { key: turnKey(SCOPE), sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; return { total: 1 }; } };
  const r1 = await dedupe.execute(op);
  assert.equal(r1.status, "acknowledged");
  assert.equal(sends, 1);
  const r2 = await dedupe.execute(op);
  assert.equal(r2.status, "duplicate");
  assert.equal(sends, 1);
  console.log("D3 acknowledged short-circuit: PASS");
}

// D4: 发送前失败 → retryable；恢复后 acknowledge
{
  const dedupe = new TurnDedupe({ memory: new Map() });
  let sends = 0;
  const op = { key: turnKey(SCOPE), sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; if (sends === 1) throw Object.assign(new Error("ECONNREFUSED"), { delivery: "definitely_not_sent" }); return { total: 1 }; } };
  const r1 = await dedupe.execute(op);
  assert.equal(r1.status, "retryable");
  assert.equal(dedupe.stateOf(op.key), "pending");
  const r2 = await dedupe.execute(op);
  assert.equal(r2.status, "acknowledged");
  assert.equal(sends, 2);
  console.log("D4 pre-send failure retryable: PASS");
}

// D5: 发送后未知（超时/断连但请求可能已到达）→ unknown，不自动重试
{
  const dedupe = new TurnDedupe({ memory: new Map() });
  let sends = 0;
  const op = { key: turnKey(SCOPE), sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; throw Object.assign(new Error("timeout after send"), { afterSend: true }); } };
  const r1 = await dedupe.execute(op);
  assert.equal(r1.status, "unknown");
  assert.equal(dedupe.stateOf(op.key), "unknown");
  const r2 = await dedupe.execute(op);
  assert.equal(r2.status, "unknown");
  assert.equal(sends, 1, "unknown must not auto-retry");
  console.log("D5 unknown ack halts retries: PASS");
}

// D6: unknown 后读回校验发现已写入 → reconcile 为 acknowledged
{
  const dedupe = new TurnDedupe({ memory: new Map() });
  const key = turnKey(SCOPE);
  await dedupe.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { throw Object.assign(new Error("timeout"), { afterSend: true }); } });
  const result = await dedupe.reconcile({ key, verify: async () => true });
  assert.equal(result.status, "acknowledged");
  console.log("D6 reconcile unknown via read-back: PASS");
}

// D7: 持久化 state 目录——重启后 acknowledged 仍是 acknowledged（不重写）
{
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-"));
  const d1 = new TurnDedupe({ stateDir: dir });
  const key = turnKey(SCOPE);
  await d1.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => ({ total: 1 }) });
  const d2 = new TurnDedupe({ stateDir: dir });
  assert.equal(d2.stateOf(key), "acknowledged");
  let sends = 0;
  const r = await d2.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; return { total: 1 }; } });
  assert.equal(r.status, "duplicate");
  assert.equal(sends, 0);
  assert.ok(existsSync(join(dir, "turns.json")));
  const persisted = JSON.parse(readFileSync(join(dir, "turns.json"), "utf8"));
  assert.equal(persisted[key].state, "acknowledged");
  console.log("D7 durable across restart: PASS");
}

// D8（R2 重写）：execute 不再接受写前 verify —— turnKey 是唯一主判据（P1-E），
// 内容匹配只允许出现在 reconcile() 的"疑似"判定里。
{
  const dedupe = new TurnDedupe({ memory: new Map() });
  const order = [];
  await dedupe.execute({
    key: turnKey(SCOPE),
    sessionId: "s",
    messages: [{ role: "user", content: "u" }],
    send: async () => {
      order.push("send");
      return { total: 1 };
    },
  });
  assert.deepEqual(order, ["send"], "fresh turn must send without content pre-check");
  // reconcile 才消费 verify
  const d2 = new TurnDedupe({ memory: new Map() });
  const key2 = turnKey({ ...SCOPE, turnId: "recon" });
  await d2.execute({ key: key2, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { throw Object.assign(new Error("t"), { delivery: "maybe_sent" }); } });
  const recon = await d2.reconcile({ key: key2, verify: async () => { order.push("verify"); return true; } });
  assert.equal(recon.status, "acknowledged");
  assert.equal(recon.suspected, true);
  assert.ok(order.includes("verify"), "reconcile must consult read-back verify");
  console.log("D8 no pre-send content check; verify only in reconcile: PASS");
}

// D9: 多进程并发 execute → 锁串行化，恰好一次发送
{
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-lock-"));
  const key = turnKey(SCOPE);
  const script = `
    import { TurnDedupe } from ${JSON.stringify(join(process.cwd(), "src/dedupe.mjs"))};
    const d = new TurnDedupe({ stateDir: ${JSON.stringify(dir)} });
    let sends = 0;
    const r = await d.execute({ key: ${JSON.stringify(key)}, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; await new Promise(r => setTimeout(r, 30)); return { total: 1 }; } });
    process.stdout.write(JSON.stringify({ status: r.status, sends }));
  `;
  const results = await Promise.all([0, 1, 2, 3].map(() =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${code}`))));
    })));
  const acknowledged = results.filter((r) => r.status === "acknowledged").length;
  const duplicates = results.filter((r) => r.status === "duplicate").length;
  assert.equal(acknowledged, 1, `exactly one acknowledged, got ${JSON.stringify(results)}`);
  assert.equal(duplicates, 3);
  assert.equal(results.reduce((sum, r) => sum + r.sends, 0), 1, "exactly one send across processes");
  console.log("D9 multi-process lock exactly-once: PASS");
}

// ── R2 RED pins ─────────────────────────────────────────────────────────────

// DB1: 拿不到跨进程锁 → deferred，且绝不发送（禁止"拿不到锁就碰运气发送"）
{
  const { mkdtempSync, mkdirSync, chmodSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-nolock-"));
  const locksDir = join(dir, "locks");
  mkdirSync(locksDir, { recursive: true });
  chmodSync(locksDir, 0o500); // 只读：mkdir 锁文件必失败
  const dedupe = new TurnDedupe({ stateDir: dir });
  let sends = 0;
  const result = await dedupe.execute({
    key: turnKey({ ...SCOPE, turnId: "nolock" }),
    sessionId: "s",
    messages: [{ role: "user", content: "u" }],
    send: async () => { sends += 1; return { total: 1 }; },
  });
  chmodSync(locksDir, 0o700);
  assert.equal(result.status, "deferred", `lock acquisition failure must defer, got ${result.status}`);
  assert.equal(sends, 0, "must not send when lock is unavailable");
  console.log("DB1 lock unavailable → deferred, no send: PASS");
}

// DB2: 持久化失败 → 降级（degraded），后续 execute 不再尝试发送
{
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-ro-"));
  const originalWriteFile = (await import("node:fs/promises")).writeFile;
  const dedupe = new TurnDedupe({ stateDir: dir, memory: new Map() });
  // 通过注入 persist 失败模拟磁盘满：直接把 turns.json 变成目录使 rename 失败
  await mkdir(join(dir, "turns.json"), { recursive: true });
  let sends = 0;
  const result = await dedupe.execute({
    key: turnKey({ ...SCOPE, turnId: "persist-fail" }),
    sessionId: "s",
    messages: [{ role: "user", content: "u" }],
    send: async () => { sends += 1; return { total: 1 }; },
  });
  assert.equal(result.status, "deferred", `persistence failure must defer, got ${result.status}`);
  assert.equal(sends, 0, "must not send when persistence is broken");
  const second = await dedupe.execute({
    key: turnKey({ ...SCOPE, turnId: "persist-fail-2" }),
    sessionId: "s",
    messages: [{ role: "user", content: "u" }],
    send: async () => { sends += 1; return { total: 1 }; },
  });
  assert.equal(second.status, "deferred", "degraded dedupe must keep deferring");
  assert.equal(sends, 0);
  console.log("DB2 persistence failure → degraded/deferred: PASS");
  void originalWriteFile;
}

// DB3: 'sending' 状态（进程崩溃残留）→ 不得无条件重发，按 unknown 对账
{
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-crash-"));
  const key = turnKey({ ...SCOPE, turnId: "crash" });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "turns.json"), JSON.stringify({ [key]: { state: "sending", attempts: 1, updatedAt: new Date().toISOString() } }));
  const dedupe = new TurnDedupe({ stateDir: dir });
  assert.equal(dedupe.stateOf(key), "sending");
  let sends = 0;
  const result = await dedupe.execute({
    key, sessionId: "s", messages: [{ role: "user", content: "u" }],
    send: async () => { sends += 1; return { total: 1 }; },
  });
  assert.equal(result.status, "unknown", `crashed sending must reconcile as unknown, got ${result.status}`);
  assert.equal(sends, 0, "must not blindly resend a crashed in-flight write");
  console.log("DB3 crashed 'sending' → unknown, no resend: PASS");
}

// DB4: 并发不同 key 跨进程状态不互覆（merge-on-write）
{
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-merge-"));
  const d1 = new TurnDedupe({ stateDir: dir });
  const d2 = new TurnDedupe({ stateDir: dir });
  await d1.execute({ key: turnKey({ ...SCOPE, turnId: "k1" }), sessionId: "s", messages: [{ role: "user", content: "u1" }], send: async () => ({ total: 1 }) });
  await d2.execute({ key: turnKey({ ...SCOPE, turnId: "k2" }), sessionId: "s", messages: [{ role: "user", content: "u2" }], send: async () => ({ total: 1 }) });
  const d3 = new TurnDedupe({ stateDir: dir });
  assert.equal(d3.stateOf(turnKey({ ...SCOPE, turnId: "k1" })), "acknowledged", "k1 must survive k2's write");
  assert.equal(d3.stateOf(turnKey({ ...SCOPE, turnId: "k2" })), "acknowledged", "k2 must be present");
  console.log("DB4 concurrent keys merge without clobber: PASS");
}

// DC1(P1-E): 同 session 同内容、不同 turnId → 必须两组（内容匹配不得误去重）
{
  const { captureTurn } = await import("../src/capture.mjs");
  const added = [];
  const client = {
    addConversation: async (args) => { added.push(args); return { total: 2 }; },
    queryConversation: async () => ({ messages: [{ role: "user", content: "相同问题" }, { role: "assistant", content: "相同回答" }] }),
  };
  const dedupe = new TurnDedupe({ memory: new Map() });
  const identity = { serviceId: "default", teamId: "team-t", userId: "usr-t", agentId: "agt-t" };
  for (const turnId of ["turn-1", "turn-2"]) {
    await captureTurn({
      client, identity, dedupe,
      turn: { client: "codex", provider: "p", sessionId: "s1", turnId, originalUser: "相同问题", finalAssistant: "相同回答", status: "completed" },
    });
  }
  assert.equal(added.length, 2, `same text in different turns must produce two record groups, got ${added.length}`);
  console.log("DC1 identical content in different turns writes both: PASS");
}

// DC2(P1-E): unknown 状态的内容匹配只能给"疑似重复"，不得无条件 acknowledged
{
  const dir = mkdtempSync(join(tmpdir(), "am-dedupe-suspect-"));
  const key = turnKey({ ...SCOPE, turnId: "suspect" });
  const d = new TurnDedupe({ stateDir: dir });
  await d.execute({
    key, sessionId: "s", messages: [{ role: "user", content: "u" }],
    send: async () => { throw Object.assign(new Error("timeout"), { delivery: "maybe_sent" }); },
  });
  assert.equal(d.stateOf(key), "unknown");
  const result = await d.reconcile({
    key,
    verify: async () => true, // 读回发现服务端已有同内容
  });
  assert.equal(result.status, "acknowledged");
  assert.equal(result.suspected, true, "content-match reconciliation must be flagged as suspected, not proof");
  console.log("DC2 read-back reconciliation flagged as suspected: PASS");
}
