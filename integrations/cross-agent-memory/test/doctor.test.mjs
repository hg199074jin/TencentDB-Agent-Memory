import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { formatDoctorReport, isClientHookConfigRegistered, runDoctor } from "../src/doctor.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-"));
  try {
    const adapterRoot = join(root, "adapter");
    await writeJson(join(adapterRoot, "config.local.json"), {
      endpoint: "http://127.0.0.1:8420",
      apiKey: "gateway-doctor-token",
      serviceId: "default",
      identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" }
    });
    await run(adapterRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function healthyGateway() {
  return {
    searchConversation: async () => [], searchAtomic: async () => [], readCore: async () => ({})
  };
}

function healthyMetadata({ assets = [{ asset_id: "asset-1", asset_type: "chat_memory", team_id: "team-1" }] } = {}) {
  return {
    getUser: async () => ({ user_id: "usr-owner", status: "active" }),
    getTeam: async () => ({ team_id: "team-1", owner_user_id: "usr-owner", status: "active" }),
    getAgent: async () => ({ agent_id: "agt-1", team_id: "team-1", owner_user_id: "usr-owner", status: "active" }),
    getTask: async () => ({ task_id: "task-1", team_id: "team-1", creator_user_id: "usr-owner", status: "active" }),
    listTaskAgents: async () => [{ task_id: "task-1", agent_id: "agt-1" }],
    listChatMemoryAssets: async () => assets
  };
}

test("doctor validates an active official graph and a visible chat_memory asset", async () => {
  await withSandbox(async (rootDir) => {
    const checks = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: healthyMetadata(),
      hookChecker: async () => true
    });
    assert.deepEqual(checks.filter((check) => check.name.startsWith("identity") || check.name === "chat-memory").map(({ name, status }) => [name, status]), [
      ["identity", "PASS"], ["chat-memory", "PASS"]
    ]);
    assert.equal(formatDoctorReport(checks).includes("gateway-doctor-token"), false);
  });
});

test("doctor reports an invalid identity graph as failure and an unwritten chat memory as waiting", async () => {
  await withSandbox(async (rootDir) => {
    const metadata = healthyMetadata({ assets: [] });
    metadata.getAgent = async () => ({ agent_id: "agt-1", team_id: "team-other", owner_user_id: "usr-owner", status: "active" });
    const checks = await runDoctor({
      rootDir,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: healthyGateway,
      metadataClient: metadata,
      hookChecker: async () => true
    });
    const result = Object.fromEntries(checks.map(({ name, status }) => [name, status]));
    assert.equal(result.identity, "FAIL");
    assert.equal(result["chat-memory"], "WAIT");
  });
});

test("doctor still accepts only complete hook registrations", () => {
  const adapterPath = "C:/memory/hook-cli.mjs";
  const command = `node ${adapterPath} codex`;
  const codex = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, commandWindows: `node \"${adapterPath}\" codex`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command, commandWindows: `node \"${adapterPath}\" codex`, timeout: 5 }] }]
    }
  };
  assert.equal(isClientHookConfigRegistered(codex, "codex", adapterPath), true);
  codex.hooks.Stop[0].hooks[0].timeout = 0;
  assert.equal(isClientHookConfigRegistered(codex, "codex", adapterPath), false);
});
