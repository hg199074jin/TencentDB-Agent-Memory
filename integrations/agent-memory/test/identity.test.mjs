// identity.mjs — 授权作用域 fail-closed 契约（RED）
import assert from "node:assert/strict";
import { createIdentityPolicy, resolveScope } from "../src/identity.mjs";

const CONFIG = {
  serviceId: "default",
  identity: {
    userId: "usr-test",
    teamId: "team-test",
    agentId: "agt-test",
    taskId: "task-test",
  },
};

// I1: 完整配置 → ok
{
  const policy = createIdentityPolicy({ config: CONFIG });
  const result = resolveScope(policy, { client: "codex" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.identity, {
    serviceId: "default",
    userId: "usr-test",
    teamId: "team-test",
    agentId: "agt-test",
    taskId: "task-test",
    sessionId: undefined,
  });
  console.log("I1 complete config resolves: PASS");
}

// I2: 缺失任一身份字段 → fail-closed 拒绝（禁止落入 default）
for (const field of ["userId", "teamId", "agentId"]) {
  const broken = { serviceId: "default", identity: { ...CONFIG.identity } };
  delete broken.identity[field];
  const policy = createIdentityPolicy({ config: broken });
  const result = resolveScope(policy, { client: "opencode" });
  assert.equal(result.ok, false, `missing ${field} must reject`);
  assert.match(result.reason, new RegExp(field));
  console.log(`I2 missing ${field} rejected: PASS`);
}

// I3: 配置了授权白名单时，不在白名单的作用域一律拒绝
{
  const policy = createIdentityPolicy({
    config: CONFIG,
    allowed: [{ teamId: "team-test", agentId: "agt-test" }],
  });
  assert.equal(resolveScope(policy, { client: "codex" }).ok, true);
  const forged = createIdentityPolicy({
    config: { serviceId: "default", identity: { ...CONFIG.identity, teamId: "team-forged", agentId: "agt-forged" } },
    allowed: [{ teamId: "team-test", agentId: "agt-test" }],
  });
  const result = resolveScope(forged, { client: "codex" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in authorized allowlist/);
  console.log("I3 forged scope rejected by allowlist: PASS");
}

// I4: sessionId 显式注入；白名单拒绝时不得返回任何可用身份
{
  const policy = createIdentityPolicy({ config: CONFIG });
  const result = resolveScope(policy, { client: "opencode", sessionId: "sess-1" });
  assert.equal(result.identity.sessionId, "sess-1");
  const forged = createIdentityPolicy({
    config: { serviceId: "default", identity: { ...CONFIG.identity, teamId: "x" } },
    allowed: [{ teamId: "team-test", agentId: "agt-test" }],
  });
  assert.equal(resolveScope(forged, { client: "opencode" }).identity, undefined);
  console.log("I4 sessionId passthrough + no identity on rejection: PASS");
}

// I5: 空 serviceId 视为缺失（禁止匿名作用域）
{
  const policy = createIdentityPolicy({ config: { serviceId: "", identity: CONFIG.identity } });
  const result = resolveScope(policy, { client: "codex" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /serviceId/);
  console.log("I5 empty serviceId rejected: PASS");
}
