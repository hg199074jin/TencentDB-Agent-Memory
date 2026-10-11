// M4：服务端 scoped 身份隔离实测（隔离 Core + 合成账号）。
// 五类越权尝试 × 读/写路径，记录当前真实行为（RED = 越权被允许即敞口）。
import assert from "node:assert/strict";

const CORE = "http://127.0.0.1:18420";
const SERVICE = "r3-test-service-bearer";
const USER_A = process.env.AM_R3_USER_A ?? ""; // 合成用户 A 的 user_key
const USER_B = process.env.AM_R3_USER_B ?? ""; // 合成用户 B 的 user_key

async function post(path, { bearer = SERVICE, userKey, body = {} } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "x-tdai-service-id": "default" };
  if (userKey) headers["x-tdai-user-key"] = userKey;
  const res = await fetch(`${CORE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, code: json?.code ?? null, data: json?.data ?? null };
}

const results = [];
function record(name, detail) { results.push({ name, ...detail }); }

// S1: 有效服务 Bearer + 缺 user-key（body 自报 user_id）
{
  const r = await post("/v3/conversation/search", { body: { user_id: "usr-01i1rhm87t", team_id: "team-r3-a", agent_id: "agt-r3-a", query: "sandro", limit: 1 } });
  record("S1 no user-key + forged body identity (read)", { status: r.status, allowed: r.code === 0 });
}
// S2: 伪造 user_id（key 属于 A，body 写 B 的 user_id）
{
  const r = await post("/v3/conversation/search", { userKey: USER_A, body: { user_id: "usr-r3-b", team_id: "team-r3-a", agent_id: "agt-r3-a", query: "x", limit: 1 } });
  record("S2 forged user_id (read)", { status: r.status, allowed: r.code === 0 });
}
// S3: team 非成员（A 的 key，body 指定一个不属于 A 的 team）
{
  const r = await post("/v3/conversation/search", { userKey: USER_A, body: { team_id: "team-FOREIGN", agent_id: "agt-foreign", user_id: "usr-01i1rhm87t", query: "x", limit: 1 } });
  record("S3 non-member team (read)", { status: r.status, allowed: r.code === 0, emptyResult: Array.isArray(r.data?.messages) && r.data.messages.length === 0 });
}
// S4: agent 无权限（A 的 key，body 指定同一 team 下未授权 agent）
{
  const r = await post("/v3/conversation/search", { userKey: USER_A, body: { team_id: "team-r3-a", agent_id: "agt-unauthorized", user_id: "usr-01i1rhm87t", query: "x", limit: 1 } });
  record("S4 unauthorized agent (read)", { status: r.status, allowed: r.code === 0 });
}
// S5: 写路径 —— A 的 key 以 B 的身份写入 L0
{
  const r = await post("/v3/conversation/add", { userKey: USER_A, body: { session_id: "r3-forge-write", user_id: "usr-r3-b", team_id: "team-r3-a", agent_id: "agt-r3-a", messages: [{ role: "user", content: "AM-R3-FORGED-WRITE-PROBE" }] } });
  record("S5 forged identity write (L0)", { status: r.status, allowed: r.code === 0 });
}

// 汇总
console.log(JSON.stringify(results, null, 1));
const anyAllowed = results.some((r) => r.allowed === true);
console.log(`M4-SUMMARY anyUnauthorizedAllowance=${anyAllowed}`);
