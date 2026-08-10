import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { formatDoctorReport, isClientHookConfigRegistered, runDoctor } from "../src/doctor.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function registerAllHooks(userProfile) {
  const group = (entry) => ({ hooks: [entry] });
  await writeJson(join(userProfile, ".codex", "hooks.json"), { hooks: {
    UserPromptSubmit: [group({ type: "command", command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`, commandWindows: `node \"${ADAPTER_PATH}\" codex`, timeout: 5 })],
    Stop: [group({ type: "command", command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`, commandWindows: `node \"${ADAPTER_PATH}\" codex`, timeout: 5 })]
  } });
  await writeJson(join(userProfile, ".claude", "settings.json"), { hooks: {
    UserPromptSubmit: [group({ type: "command", command: `node \"${ADAPTER_PATH}\" claude`, timeout: 5 })],
    Stop: [group({ type: "command", command: `node \"${ADAPTER_PATH}\" claude`, timeout: 5 })]
  } });
  await writeJson(join(userProfile, ".zcode", "cli", "config.json"), { hooks: {
    enabled: true,
    events: {
      UserPromptSubmit: [group({ type: "process", command: "node", args: [ADAPTER_PATH, "zcode"], enabled: true, timeoutMs: 5000 })],
      Stop: [group({ type: "process", command: "node", args: [ADAPTER_PATH, "zcode"], enabled: true, timeoutMs: 5000 })]
    }
  } });
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

function healthyMetadata({ assets = [{ asset_id: "chat_memory-team-1-agt-1", asset_type: "chat_memory", team_id: "team-1", owner_user_id: "usr-owner", status: "active" }] } = {}) {
  return {
    getUser: async () => ({ user_id: "usr-owner", status: "active" }),
    getTeam: async () => ({ team_id: "team-1", owner_user_id: "usr-owner", status: "active" }),
    getAgent: async () => ({ agent_id: "agt-1", team_id: "team-1", owner_user_id: "usr-owner", status: "active" }),
    getTask: async () => ({ task_id: "task-1", team_id: "team-1", creator_user_id: "usr-owner", status: "running" }),
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
    assert.equal(result["chat-memory"], "FAIL");
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

test("doctor retains full legacy PASS, FAIL, optional-write, missing-config, and hook-negative coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-legacy-"));
  try {
    const adapterRoot = join(root, "adapter");
    const userProfile = join(root, "profile");
    await writeJson(join(adapterRoot, "config.local.json"), {
      endpoint: "http://127.0.0.1:8420", apiKey: "doctor-secret", serviceId: "default",
      identity: { userId: "usr-owner", teamId: "team-1", agentId: "agt-1", taskId: "task-1" }
    });
    await registerAllHooks(userProfile);
    let writes = 0;
    const options = {
      rootDir: adapterRoot, userProfile, adapterPath: ADAPTER_PATH, nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: () => ({ ...healthyGateway(), addConversation: async () => { writes += 1; } }),
      metadataClient: healthyMetadata()
    };
    const checks = await runDoctor(options);
    for (const name of ["config", "node", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory", "hook-codex", "hook-claude", "hook-zcode"]) {
      assert.equal(checks.find((check) => check.name === name).status, "PASS", name);
    }
    assert.equal(writes, 0);
    assert.equal(formatDoctorReport(checks).includes("doctor-secret"), false);
    const withWrite = await runDoctor({ ...options, write: true });
    assert.equal(withWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 1);

    await writeJson(join(userProfile, ".codex", "hooks.json"), { hooks: { UserPromptSubmit: [], Stop: [] } });
    const failed = await runDoctor({
      ...options,
      nodeVersion: "22.15.0",
      healthCheck: async () => { throw new Error("sensitive failure"); },
      gatewayFactory: () => ({ ...healthyGateway(), searchConversation: async () => { throw new Error("sensitive failure"); } })
    });
    const statuses = Object.fromEntries(failed.map(({ name, status }) => [name, status]));
    assert.equal(statuses.node, "FAIL");
    assert.equal(statuses.gateway, "FAIL");
    assert.equal(statuses.l0, "FAIL");
    assert.equal(statuses["hook-codex"], "FAIL");
    assert.equal(formatDoctorReport(failed).includes("sensitive failure"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const missingRoot = await mkdtemp(join(tmpdir(), "cross-agent-doctor-missing-"));
  try {
    const missing = await runDoctor({ rootDir: join(missingRoot, "adapter"), userProfile: join(missingRoot, "profile"), nodeVersion: "25.2.1", healthCheck: async () => true });
    for (const name of ["config", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory"]) {
      assert.equal(missing.find((check) => check.name === name).status, "FAIL", name);
    }
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});

test("doctor rejects every incomplete handler shape for Codex, Claude, and ZCode", () => {
  const path = "C:/memory/hook-cli.mjs";
  const codex = { type: "command", command: `node ${path} codex`, commandWindows: `node \"${path}\" codex`, timeout: 5 };
  const claude = { type: "command", command: `node \"${path}\" claude`, timeout: 5 };
  const zcode = { type: "process", command: "node", args: [path, "zcode"], enabled: true, timeoutMs: 5000 };
  const configFor = (client, entry, enabled = true) => client === "zcode"
    ? { hooks: { enabled, events: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } } }
    : { hooks: { UserPromptSubmit: [{ hooks: [entry] }], Stop: [{ hooks: [entry] }] } };
  assert.equal(isClientHookConfigRegistered(configFor("codex", codex), "codex", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("claude", claude), "claude", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", zcode), "zcode", path), true);
  assert.equal(isClientHookConfigRegistered(configFor("codex", { ...codex, timeout: 0 }), "codex", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("claude", { ...claude, command: `node \"${path}\" codex` }), "claude", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", { ...zcode, args: [path, "claude"] }), "zcode", path), false);
  assert.equal(isClientHookConfigRegistered(configFor("zcode", zcode, false), "zcode", path), false);
});

test("doctor marks missing configuration and both metadata checks as failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-missing-explicit-"));
  try {
    const checks = await runDoctor({ rootDir: join(root, "adapter"), userProfile: join(root, "profile"), nodeVersion: "25.2.1", healthCheck: async () => true });
    for (const name of ["config", "gateway", "l0", "l1", "l3", "write", "identity", "chat-memory"]) {
      assert.equal(checks.find((check) => check.name === name).status, "FAIL", name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor fails malformed official IDs and does not downgrade the asset check to WAIT", async () => {
  await withSandbox(async (rootDir) => {
    const metadata = healthyMetadata({ assets: [] });
    metadata.getTeam = async () => ({ team_id: "bad-team", owner_user_id: "usr-owner", status: "active" });
    const checks = await runDoctor({ rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory: healthyGateway, metadataClient: metadata, hookChecker: async () => true });
    assert.equal(checks.find((check) => check.name === "identity").status, "FAIL");
    assert.equal(checks.find((check) => check.name === "chat-memory").status, "FAIL");
  });
});

test("doctor executes its write probe only with --write behavior", async () => {
  await withSandbox(async (rootDir) => {
    let writes = 0;
    const gatewayFactory = () => ({ ...healthyGateway(), addConversation: async () => { writes += 1; } });
    const options = { rootDir, nodeVersion: "25.2.1", healthCheck: async () => true, gatewayFactory, metadataClient: healthyMetadata(), hookChecker: async () => true };
    const withoutWrite = await runDoctor(options);
    assert.equal(withoutWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 0);
    const withWrite = await runDoctor({ ...options, write: true });
    assert.equal(withWrite.find((check) => check.name === "write").status, "PASS");
    assert.equal(writes, 1);
  });
});

test("doctor preserves both primary and cleanup errors in its sandbox helper", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  async function sandbox(run, remove) {
    const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-cleanup-"));
    let bodyError;
    try { await run(root); } catch (error) { bodyError = error; }
    let cleanupError;
    try { await remove(root); } catch (error) { cleanupError = error; }
    if (bodyError && cleanupError) throw new AggregateError([bodyError, cleanupError]);
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  }
  await assert.rejects(sandbox(async () => { throw primary; }, async () => { throw cleanup; }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
});
