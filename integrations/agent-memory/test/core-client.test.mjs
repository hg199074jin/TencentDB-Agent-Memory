// core-client.mjs — 与官方 SDK v3 契约对齐（RED）
import assert from "node:assert/strict";
import { CoreClient, CoreTransportError } from "../src/core-client.mjs";

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

const ENV = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "test-bearer",
  serviceId: "default",
  isolation: { team_id: "team-t", agent_id: "agt-t", user_id: "usr-t", task_id: "task-t" },
};

function okHandler(data) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, message: "ok", request_id: "r1", data }),
  });
}

// C1: 方法名与官方 SDK v3 一致；请求体带隔离上下文字段
{
  const fetchImpl = mockFetch(okHandler({ messages: [{ id: "m1", content: "x" }] }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  const data = await client.searchConversation({ query: "hi", limit: 3 });
  assert.deepEqual(data.messages.map((m) => m.id), ["m1"]);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "http://127.0.0.1:8420/v3/conversation/search");
  const body = JSON.parse(call.init.body);
  assert.equal(body.team_id, "team-t");
  assert.equal(body.agent_id, "agt-t");
  assert.equal(body.user_id, "usr-t");
  assert.equal(body.task_id, "task-t");
  assert.equal(body.query, "hi");
  assert.equal(call.init.headers["Authorization"], "Bearer test-bearer");
  assert.equal(call.init.headers["x-tdai-service-id"], "default");
  console.log("C1 searchConversation contract: PASS");
}

// C2: addConversation 带 session_id + messages（与 V3ConversationAddRequest 对齐）
{
  const fetchImpl = mockFetch(okHandler({ total: 2 }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  const data = await client.addConversation({
    sessionId: "opencode-abc",
    messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }],
  });
  assert.equal(data.total, 2);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.session_id, "opencode-abc");
  assert.equal(body.messages.length, 2);
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:8420/v3/conversation/add");
  console.log("C2 addConversation contract: PASS");
}

// C3: 其余 v3 方法存在且路径正确
{
  const fetchImpl = mockFetch(okHandler({ items: [] }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await client.searchAtomic({ query: "q", limit: 5 });
  await client.queryConversation({ sessionId: "s", limit: 10 });
  await client.readCore();
  await client.listScenarios();
  await client.readScenario({ name: "scene.md" });
  const paths = fetchImpl.calls.map((c) => c.url.replace("http://127.0.0.1:8420", ""));
  assert.deepEqual(paths, [
    "/v3/atomic/search",
    "/v3/conversation/query",
    "/v3/core/read",
    "/v3/scenario/ls",
    "/v3/scenario/read",
  ]);
  console.log("C3 method surface: PASS");
}

// C4: envelope code != 0 → 抛错（不静默成功）
{
  const fetchImpl = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 1001, message: "unauthorized", request_id: "r", data: null }),
  }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(() => client.readCore(), /unauthorized/);
  console.log("C4 envelope error surfaces: PASS");
}

// C5: 传输失败 → CoreTransportError（可观测分类），且带 AbortSignal 超时
{
  const fetchImpl = mockFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const client = new CoreClient({ ...ENV, fetchImpl, timeoutMs: 50 });
  await assert.rejects(() => client.readCore(), (err) => {
    assert.ok(err instanceof CoreTransportError);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
  console.log("C5 transport error typed: PASS");
}

// C6: withIsolation 覆盖隔离字段且不污染原实例
{
  const fetchImpl = mockFetch(okHandler({ content: "p" }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  const scoped = client.withIsolation({ teamId: "team-other" });
  await scoped.readCore();
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.team_id, "team-other");
  await client.readCore();
  const body2 = JSON.parse(fetchImpl.calls[1].init.body);
  assert.equal(body2.team_id, "team-t");
  console.log("C6 withIsolation override: PASS");
}

// C7: 请求超时触发 AbortSignal（模拟慢响应）
{
  const fetchImpl = mockFetch((url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  );
  const client = new CoreClient({ ...ENV, fetchImpl, timeoutMs: 30 });
  await assert.rejects(() => client.readCore(), /timed out|aborted/i);
  console.log("C7 timeout aborts: PASS");
}

// ── R2 RED pins：官方 v3 SDK 契约 ───────────────────────────────────────────

// D-C1: readScenario 必须发送 { path }（官方 V3ScenarioReadRequest.path）
{
  const fetchImpl = mockFetch(okHandler({ scenario: "s" }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await client.readScenario({ name: "scene-a.md" });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.path, "scene-a.md", `readScenario must send path=, got ${JSON.stringify(body)}`);
  assert.equal(body.scenario, undefined, "readScenario must not send legacy scenario field");
  console.log("D-C1 readScenario sends path: PASS");
}

// D-C2: listScenarios 必须发送 { path_prefix }，不得用 session_id
{
  const fetchImpl = mockFetch(okHandler({ entries: [] }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await client.listScenarios({ pathPrefix: "proj/" });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.path_prefix, "proj/", `listScenarios must send path_prefix, got ${JSON.stringify(body)}`);
  assert.equal(body.session_id, undefined, "listScenarios must not send session_id");
  await client.listScenarios();
  const body2 = JSON.parse(fetchImpl.calls[1].init.body);
  assert.equal(body2.path_prefix, undefined);
  assert.equal(body2.session_id, undefined);
  console.log("D-C2 listScenarios sends path_prefix: PASS");
}
