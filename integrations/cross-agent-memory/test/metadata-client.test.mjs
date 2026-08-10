import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { MetadataClient } from "../src/metadata-client.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("metadata client rejects a structurally incomplete successful envelope", async () => {
  await withServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, data: { valid: true, user: { user_id: "usr-1", status: "active" } } }));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await assert.rejects(client.verifyCurrentUser(), /invalid metadata api response/i);
  });
});

test("metadata client uses the documented 100-item list limit in real request bodies", async () => {
  let body;
  await withServer(async (request, response) => {
    body = await new Promise((resolve) => {
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { source += chunk; });
      request.on("end", () => resolve(JSON.parse(source)));
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-1", data: { items: [] } }));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await client.listTeams({ userId: "usr-1", name: "个人跨 Agent 记忆" });
    assert.deepEqual(body, { user_id: "usr-1", name: "个人跨 Agent 记忆", limit: 100 });
  });
});

test("every metadata list endpoint sends a 100-item limit", async () => {
  const bodies = [];
  await withServer(async (request, response) => {
    const source = await new Promise((resolve) => {
      let value = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { value += chunk; });
      request.on("end", () => resolve(value));
    });
    bodies.push(JSON.parse(source));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-2", data: { items: [] } }));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await client.listAgents({ teamId: "team-1", name: "共享个人助手" });
    await client.listTasks({ teamId: "team-1", title: "日常共享对话" });
    await client.listTaskAgents({ taskId: "task-1" });
    await client.listChatMemoryAssets({ teamId: "team-1", agentId: "agt-1" });
  });
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies.map((body) => body.limit), [100, 100, 100, 100]);
});
