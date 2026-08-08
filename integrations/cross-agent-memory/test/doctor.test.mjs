import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  formatDoctorReport,
  isClientHookConfigRegistered,
  runDoctor
} from "../src/doctor.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withSandbox(run, { remove = rm } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-doctor-"));
  let primaryError;
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
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await remove(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError]);
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function registerAllHooks(userProfile) {
  const commandGroup = (client) => ({ hooks: [client === "codex" ? {
    type: "command",
    command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`,
    commandWindows: `node \"${ADAPTER_PATH}\" codex`,
    timeout: 5
  } : {
    type: "command",
    command: `node \"${ADAPTER_PATH}\" claude`,
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

function configFor(client, entry, enabled = true) {
  const group = { hooks: [entry] };
  if (client === "zcode") {
    return { hooks: { enabled, events: { UserPromptSubmit: [group], Stop: [group] } } };
  }
  return { hooks: { UserPromptSubmit: [group], Stop: [group] } };
}

function validEntry(client) {
  if (client === "codex") {
    return {
      type: "command",
      command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`,
      commandWindows: `node \"${ADAPTER_PATH}\" codex`,
      timeout: 5
    };
  }
  if (client === "claude") {
    return { type: "command", command: `node \"${ADAPTER_PATH}\" claude`, timeout: 5 };
  }
  return {
    type: "process",
    command: "node",
    args: [ADAPTER_PATH, "zcode"],
    enabled: true,
    timeoutMs: 5000
  };
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

test("doctor accepts only the complete current handler shape for every client", () => {
  for (const client of ["codex", "claude", "zcode"]) {
    assert.equal(
      isClientHookConfigRegistered(configFor(client, validEntry(client)), client, ADAPTER_PATH),
      true,
      `${client} valid handler`
    );
  }

  const codexInvalid = [
    { ...validEntry("codex"), type: "process" },
    { ...validEntry("codex"), command: `node ${ADAPTER_PATH.replaceAll("\\", "/")}.old codex` },
    { ...validEntry("codex"), commandWindows: `node \"${ADAPTER_PATH}-backup\" codex` },
    { ...validEntry("codex"), command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} claude`, commandWindows: `node \"${ADAPTER_PATH}\" claude` },
    { ...validEntry("codex"), command: `bun ${ADAPTER_PATH.replaceAll("\\", "/")} codex` },
    { ...validEntry("codex"), timeout: 0 }
  ];
  const claudeInvalid = [
    { ...validEntry("claude"), type: "process" },
    { ...validEntry("claude"), command: `node \"${ADAPTER_PATH}.old\" claude` },
    { ...validEntry("claude"), command: `node \"${ADAPTER_PATH}\" codex` },
    { ...validEntry("claude"), command: `bun \"${ADAPTER_PATH}\" claude` },
    { ...validEntry("claude"), timeout: 0 }
  ];
  const zcodeInvalid = [
    { ...validEntry("zcode"), type: "command" },
    { ...validEntry("zcode"), command: "node.exe" },
    { ...validEntry("zcode"), args: [`${ADAPTER_PATH}.old`, "zcode"] },
    { ...validEntry("zcode"), args: [ADAPTER_PATH, "claude"] },
    { ...validEntry("zcode"), args: [ADAPTER_PATH, "zcode", "extra"] },
    { ...validEntry("zcode"), enabled: false },
    { ...validEntry("zcode"), timeoutMs: 0 }
  ];

  for (const entry of codexInvalid) {
    assert.equal(isClientHookConfigRegistered(configFor("codex", entry), "codex", ADAPTER_PATH), false);
  }
  for (const entry of claudeInvalid) {
    assert.equal(isClientHookConfigRegistered(configFor("claude", entry), "claude", ADAPTER_PATH), false);
  }
  for (const entry of zcodeInvalid) {
    assert.equal(isClientHookConfigRegistered(configFor("zcode", entry), "zcode", ADAPTER_PATH), false);
  }
  assert.equal(
    isClientHookConfigRegistered(configFor("zcode", validEntry("zcode"), false), "zcode", ADAPTER_PATH),
    false
  );
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

test("doctor sandbox preserves both a primary failure and a cleanup failure", async () => {
  const primary = new Error("primary test failure");
  const cleanup = new Error("cleanup test failure");
  await assert.rejects(
    withSandbox(async () => { throw primary; }, { remove: async () => { throw cleanup; } }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup
  );
});
