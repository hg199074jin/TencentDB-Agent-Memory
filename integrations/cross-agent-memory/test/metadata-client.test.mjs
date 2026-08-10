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
