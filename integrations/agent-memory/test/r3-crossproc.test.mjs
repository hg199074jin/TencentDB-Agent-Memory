// M1-C RED：跨进程旧状态不得覆盖新进程的终态。
// 场景：P1 内存里有 key K 的旧 pending；P2 已把 K 落盘为 acknowledged；
// P1 之后持久化"另一个 key"时，不得把 K 回写成 stale pending。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDedupe, turnKey } from "../src/dedupe.mjs";

const SCOPE = { serviceId: "default", teamId: "team-t", userId: "usr-t", agentId: "agt-t", client: "codex", sessionId: "s", turnId: "t" };

// DC-R1: P1 陈旧内存态持久化时不得回写 P2 的 acknowledged
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-dc1-"));
  const sharedKey = turnKey(SCOPE);
  const otherKey = turnKey({ ...SCOPE, turnId: "other" });

  // T0：盘上 sharedKey=pending（P1 早先一次发送前失败留下的）
  const seed = new TurnDedupe({ stateDir: dir, memory: new Map() });
  await seed.execute({
    key: sharedKey, sessionId: "s", messages: [{ role: "user", content: "u" }],
    send: async () => { throw Object.assign(new Error("refused"), { delivery: "definitely_not_sent" }); },
  });

  // T1：P1 启动，加载到 sharedKey=pending（此后其内存不再刷新）
  const p1 = new TurnDedupe({ stateDir: dir });

  // T2：另一进程 P2 完成该 turn → 盘上 acknowledged
  const p2 = new TurnDedupe({ stateDir: dir });
  await p2.execute({ key: sharedKey, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => ({ total: 1 }) });

  // T3：P1 经 markAcknowledged（无 reload）触发整张 Map merge-on-write
  await p1.markAcknowledged(otherKey, { via: "spool-retry" });

  const onDisk = JSON.parse(readFileSync(join(dir, "turns.json"), "utf8"));
  assert.equal(onDisk[sharedKey].state, "acknowledged", `stale pending must not overwrite acknowledged, got ${onDisk[sharedKey].state}`);
  assert.equal(onDisk[otherKey].state, "acknowledged", "P1's own key must be persisted");
  console.log("DC-R1 stale memory cannot regress a terminal state: PASS");
}

// DC-R2: 终态不得倒退 —— unknown/denied 也不得被 pending/sending 覆盖
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-dc2-"));
  const key = turnKey({ ...SCOPE, turnId: "t2" });
  // T0：P1 早先 attempts → 盘上 sending（进程崩溃前最后状态）
  const seed = new TurnDedupe({ stateDir: dir, memory: new Map() });
  await seed.execute({
    key, sessionId: "s", messages: [{ role: "user", content: "u" }],
    send: async () => { throw Object.assign(new Error("timeout"), { delivery: "maybe_sent" }); },
  });
  // seed 把 key 置为 unknown；改写盘为 sending 模拟"发送中被杀"
  const current = JSON.parse(readFileSync(join(dir, "turns.json"), "utf8"));
  current[key].state = "sending";
  writeFileSync(join(dir, "turns.json"), JSON.stringify(current));

  // T1：P1 启动加载（内存 key=sending）；T2：P2 execute 见到 sending → 收敛为 unknown
  const p1 = new TurnDedupe({ stateDir: dir });
  const p2 = new TurnDedupe({ stateDir: dir });
  const recovered = await p2.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => ({ total: 1 }) });
  assert.equal(recovered.status, "unknown");

  // T3：P1 无 reload 持久化另一个 key
  await p1.markAcknowledged(turnKey({ ...SCOPE, turnId: "t3" }), { via: "spool-retry" });
  const onDisk = JSON.parse(readFileSync(join(dir, "turns.json"), "utf8"));
  assert.equal(onDisk[key].state, "unknown", `unknown must not regress to sending, got ${onDisk[key].state}`);
  console.log("DC-R2 terminal unknown not regressed: PASS");
}

// DC-R3: 损坏的 turns.json → fail-closed（degraded），不得当空状态继续发送
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-dc3-"));
  writeFileSync(join(dir, "turns.json"), "{corrupted json");
  const dedupe = new TurnDedupe({ stateDir: dir });
  const key = turnKey({ ...SCOPE, turnId: "t4" });
  // 先把已知终态写进去（正常路径），再损坏文件，验证后续行为
  const p = new TurnDedupe({ stateDir: dir });
  await p.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => ({ total: 1 }) });
  writeFileSync(join(dir, "turns.json"), "{corrupted json");
  const d2 = new TurnDedupe({ stateDir: dir });
  let sends = 0;
  const r = await d2.execute({ key, sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => { sends += 1; return { total: 1 }; } });
  // 腐败文件丢弃全部已知状态：此时无法证明该 turn 已写 —— 必须 deferred（不能盲发）
  assert.equal(r.status, "deferred", `corrupted state must defer, got ${r.status}`);
  assert.equal(sends, 0);
  console.log("DC-R3 corrupted state file → deferred, no send: PASS");
}

// DC-R4: 磁盘不可写 → degraded，后续 execute 一律 deferred（已有 DB2 覆盖，此处验证恢复）
{
  const dir = mkdtempSync(join(tmpdir(), "am-r3-dc4-"));
  await (await import("node:fs/promises")).mkdir(dir + "/turns.json", { recursive: true });
  const d = new TurnDedupe({ stateDir: dir });
  const r = await d.execute({ key: turnKey({ ...SCOPE, turnId: "t5" }), sessionId: "s", messages: [{ role: "user", content: "u" }], send: async () => ({ total: 1 }) });
  assert.equal(r.status, "deferred");
  assert.equal(d.isDegraded(), true);
  console.log("DC-R4 disk unwritable → degraded: PASS");
}
