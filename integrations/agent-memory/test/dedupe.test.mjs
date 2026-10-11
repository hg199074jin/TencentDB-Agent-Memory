// dedupe.mjs — turnKey 公式、状态机、持久化、未知 ACK（RED）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
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
  const op = { key: turnKey(SCOPE), sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; if (sends === 1) throw new Error("ECONNREFUSED"); return { total: 1 }; } };
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

// D8: verify 在 acknowledged 前执行（读回优先于发送）
{
  const order = [];
  const dedupe = new TurnDedupe({ memory: new Map() });
  await dedupe.execute({
    key: turnKey(SCOPE),
    sessionId: "s",
    messages: [{ role: "user", content: "u" }],
    verify: async () => {
      order.push("verify");
      return false;
    },
    send: async () => {
      order.push("send");
      return { total: 1 };
    },
  });
  assert.deepEqual(order, ["verify", "send"]);
  console.log("D8 verify-before-send ordering: PASS");
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
