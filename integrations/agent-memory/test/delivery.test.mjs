// P0-A RED：CoreClient 必须提供"写入送达状态"判别联合（delivery）。
// 修复前：CoreTransportError 无 delivery 字段；dedupe 靠不存在的 afterSend 判断。
import assert from "node:assert/strict";
import { CoreClient, CoreTransportError } from "../src/core-client.mjs";
import { TurnDedupe, turnKey } from "../src/dedupe.mjs";

const SCOPE = { serviceId: "default", teamId: "team-t", userId: "usr-t", agentId: "agt-t", client: "codex", sessionId: "s1", turnId: "t1" };

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
  apiKey: "k",
  serviceId: "default",
  isolation: { team_id: "team-t", agent_id: "agt-t", user_id: "usr-t" },
  timeoutMs: 50,
};

// DA1: 请求已发出但超时（无响应）→ maybe_sent（可能已落库，不得自动重试）
{
  const fetchImpl = mockFetch(() => new Promise((_resolve, reject) => {
    setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 10);
  }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(
    () => client.addConversation({ sessionId: "s", messages: [{ role: "user", content: "u" }] }),
    (error) => {
      assert.ok(error instanceof CoreTransportError);
      assert.equal(error.delivery, "maybe_sent", `timeout must be maybe_sent, got ${error.delivery}`);
      return true;
    },
  );
  console.log("DA1 timeout-after-send → maybe_sent: PASS");
}

// DA2: 连接拒绝（请求完全未送达）→ definitely_not_sent
{
  const fetchImpl = mockFetch(() => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(
    () => client.readCore(),
    (error) => {
      assert.equal(error.delivery, "definitely_not_sent", `ECONNREFUSED must be definitely_not_sent, got ${error.delivery}`);
      return true;
    },
  );
  console.log("DA2 connection refused → definitely_not_sent: PASS");
}

// DA3: 授权拒绝（HTTP 401/403）→ rejected，不是网络失败，不得重试/不得退化身份
{
  const fetchImpl = mockFetch(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ code: 1001, message: "unauthorized", request_id: "r" }),
  }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(
    () => client.addConversation({ sessionId: "s", messages: [{ role: "user", content: "u" }] }),
    (error) => {
      assert.equal(error.delivery, "rejected", `401 must be rejected, got ${error.delivery}`);
      assert.equal(error.status, 401);
      return true;
    },
  );
  console.log("DA3 HTTP 401 → rejected: PASS");
}

// DA4: envelope code != 0 → rejected
{
  const fetchImpl = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 1211, message: "模型不存在", request_id: "r", data: null }),
  }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(() => client.readCore(), (error) => {
    assert.equal(error.delivery, "rejected");
    assert.equal(error.code, 1211);
    return true;
  });
  console.log("DA4 envelope error → rejected: PASS");
}

// DA5: 响应头已收到、响应体读取中断 → maybe_sent（服务端可能已提交）
{
  const fetchImpl = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw Object.assign(new Error("terminated"), { cause: { code: "ECONNRESET" } });
    },
  }));
  const client = new CoreClient({ ...ENV, fetchImpl });
  await assert.rejects(() => client.readCore(), (error) => {
    assert.equal(error.delivery, "maybe_sent", `partial body must be maybe_sent, got ${error.delivery}`);
    return true;
  });
  console.log("DA5 partial-body → maybe_sent: PASS");
}

// DA6: dedupe 对三种 delivery 的状态迁移
//   maybe_sent → unknown（禁止自动重试）
//   definitely_not_sent → retryable（pending 保留）
//   rejected → denied（不重试、不入 spool）
{
  const mk = (delivery) => Object.assign(new Error("x"), { delivery, name: "CoreTransportError" });
  const cases = [
    ["maybe_sent", "unknown"],
    ["definitely_not_sent", "retryable"],
    ["rejected", "denied"],
  ];
  for (const [delivery, expected] of cases) {
    const dedupe = new TurnDedupe({ memory: new Map() });
    let sends = 0;
    const result = await dedupe.execute({
      key: turnKey({ ...SCOPE, turnId: `t-${delivery}` }),
      sessionId: "s",
      messages: [{ role: "user", content: "u" }],
      send: async () => {
        sends += 1;
        throw mk(delivery);
      },
    });
    assert.equal(result.status, expected, `delivery=${delivery} must map to ${expected}, got ${result.status}`);
    // 再次 execute：unknown/denied 不得重发；retryable(pending) 可重试
    const result2 = await dedupe.execute({
      key: turnKey({ ...SCOPE, turnId: `t-${delivery}` }),
      sessionId: "s",
      messages: [{ role: "user", content: "u" }],
      send: async () => {
        sends += 1;
        throw mk(delivery);
      },
    });
    if (expected === "retryable") {
      assert.equal(sends, 2, "pre-send failure must remain retryable");
    } else {
      assert.equal(sends, 1, `${expected} must not auto-retry`);
    }
    console.log(`DA6 delivery=${delivery} → ${expected}: PASS`);
  }
}

// DA7: rejected（授权失败）经 capture 不得进入 spool（hook-cli 侧断言见 hook-cli 测试）
{
  const { captureTurn } = await import("../src/capture.mjs");
  const dedupe = new TurnDedupe({ memory: new Map() });
  const client = {
    addConversation: async () => {
      throw Object.assign(new Error("unauthorized"), { delivery: "rejected", status: 401, name: "CoreTransportError" });
    },
    queryConversation: async () => ({ messages: [] }),
  };
  const receipt = await captureTurn({
    client,
    identity: { serviceId: "default", teamId: "team-t", userId: "usr-t", agentId: "agt-t" },
    dedupe,
    turn: { client: "codex", provider: "p", sessionId: "s1", turnId: "t1", originalUser: "问题", finalAssistant: "回答", status: "completed" },
  });
  assert.equal(receipt.status, "denied", `authorization rejection must be denied, got ${receipt.status}`);
  console.log("DA7 capture surfaces denied on authorization rejection: PASS");
}
