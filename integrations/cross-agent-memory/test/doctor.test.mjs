import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { formatDoctorReport, runDoctor } from "../src/doctor.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-"));
  try {
    const adapterRoot = join(root, "adapter");
    const userProfile = join(root, "profile");
    await writeJson(join(adapterRoot, "config.local.json"), {
      endpoint: "http://127.0.0.1:8420",
      apiKey: "doctor-test-placeholder",
      serviceId: "default",
      identity: {
        teamId: "team-personal-memory",
        agentId: "agent-personal-assistant",
        userId: "user-jin-z",
        taskId: "task-cross-agent-chat"
      }
    });
    await run({ root, adapterRoot, userProfile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function registerAllHooks(userProfile) {
  const commandGroup = (client) => ({ hooks: [{
    type: "command",
    command: `node \"${ADAPTER_PATH}\" ${client}`,
    commandWindows: client === "codex" ? `node \"${ADAPTER_PATH}\" codex` : undefined,
    timeout: 5
  }] });
  await writeJson(join(userProfile, ".codex", "hooks.json"), {
    hooks: {
      UserPromptSubmit: [commandGroup("codex")],
      Stop: [commandGroup("codex")]
    }
  });
  await writeJson(join(userProfile, ".claude", "settings.json"), {
    hooks: {
      UserPromptSubmit: [commandGroup("claude")],
      Stop: [commandGroup("claude")]
    }
  });
  const zcodeGroup = {
    hooks: [{ type: "process", command: "node", args: [ADAPTER_PATH, "zcode"], enabled: true, timeoutMs: 5000 }]
  };
  await writeJson(join(userProfile, ".zcode", "cli", "config.json"), {
    hooks: {
      enabled: true,
      events: { UserPromptSubmit: [zcodeGroup], Stop: [zcodeGroup] }
    }
  });
}

function makeGateway(overrides = {}) {
  return {
    searchConversation: async () => [],
    searchAtomic: async () => [],
    readCore: async () => ({}),
    addConversation: async () => ({}),
    ...overrides
  };
}

test("doctor emits one sanitized PASS result for every required check", async () => {
  await withSandbox(async ({ adapterRoot, userProfile }) => {
    await registerAllHooks(userProfile);
    const checks = await runDoctor({
      rootDir: adapterRoot,
      userProfile,
      adapterPath: ADAPTER_PATH,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: () => makeGateway()
    });

    assert.deepEqual(checks.map(({ name, status }) => [name, status]), [
      ["config", "PASS"],
      ["node", "PASS"],
      ["gateway", "PASS"],
      ["l0", "PASS"],
      ["l1", "PASS"],
      ["l3", "PASS"],
      ["write", "PASS"],
      ["hook-codex", "PASS"],
      ["hook-claude", "PASS"],
      ["hook-zcode", "PASS"]
    ]);
    const report = formatDoctorReport(checks);
    assert.equal(report.includes("doctor-test-placeholder"), false);
    assert.equal(report.includes("对话正文"), false);
  });
});

test("doctor reports sanitized failures and detects incomplete matcher groups", async () => {
  await withSandbox(async ({ adapterRoot, userProfile }) => {
    await registerAllHooks(userProfile);
    const codexPath = join(userProfile, ".codex", "hooks.json");
    await writeJson(codexPath, { hooks: { UserPromptSubmit: [{ hooks: [{
      type: "command",
      commandWindows: `node \"${ADAPTER_PATH}\" codex`
    }] }], Stop: [] } });
    const secretError = "sensitive-test-detail";
    const checks = await runDoctor({
      rootDir: adapterRoot,
      userProfile,
      adapterPath: ADAPTER_PATH,
      nodeVersion: "22.15.0",
      healthCheck: async () => { throw new Error(secretError); },
      gatewayFactory: () => makeGateway({
        searchConversation: async () => { throw new Error(secretError); }
      })
    });

    const byName = Object.fromEntries(checks.map((check) => [check.name, check.status]));
    assert.equal(byName.node, "FAIL");
    assert.equal(byName.gateway, "FAIL");
    assert.equal(byName.l0, "FAIL");
    assert.equal(byName["hook-codex"], "FAIL");
    assert.equal(byName.l1, "PASS");
    const report = formatDoctorReport(checks);
    assert.equal(report.includes(secretError), false);
    assert.match(report, /^\[(?:PASS|FAIL)\] /m);
  });
});

test("doctor performs the optional write only when explicitly enabled", async () => {
  await withSandbox(async ({ adapterRoot, userProfile }) => {
    await registerAllHooks(userProfile);
    let writes = 0;
    const options = {
      rootDir: adapterRoot,
      userProfile,
      adapterPath: ADAPTER_PATH,
      nodeVersion: "25.2.1",
      healthCheck: async () => true,
      gatewayFactory: () => makeGateway({ addConversation: async () => { writes += 1; } })
    };

    const withoutWrite = await runDoctor(options);
    assert.equal(writes, 0);
    assert.equal(withoutWrite.find(({ name }) => name === "write").status, "PASS");

    const withWrite = await runDoctor({ ...options, write: true });
    assert.equal(writes, 1);
    assert.equal(withWrite.find(({ name }) => name === "write").status, "PASS");
  });
});

test("doctor marks dependent checks failed when config is missing without leaking the cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-missing-"));
  try {
    const checks = await runDoctor({
      rootDir: join(root, "adapter"),
      userProfile: join(root, "profile"),
      adapterPath: ADAPTER_PATH,
      nodeVersion: "25.2.1",
      healthCheck: async () => true
    });
    for (const name of ["config", "gateway", "l0", "l1", "l3", "write"]) {
      assert.equal(checks.find((check) => check.name === name).status, "FAIL");
    }
    assert.equal(formatDoctorReport(checks).includes("config.local.json"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
