import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installHooks, uninstallHooks } from "../src/install-hooks.mjs";

const ADAPTER_PATH = resolve("integrations/cross-agent-memory/src/hook-cli.mjs");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listOrEmpty(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-hooks-"));
  const userProfile = join(root, "home");
  const runtimeDir = join(root, "runtime");
  await mkdir(userProfile, { recursive: true });

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = userProfile;
  process.env.USERPROFILE = userProfile;
  try {
    await run({ root, userProfile, runtimeDir });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    await rm(root, { recursive: true, force: true });
  }
}

function managedCount(config, event, client) {
  if (client === "zcode") {
    return config.hooks.events[event].filter((entry) =>
      entry.type === "process" && entry.args?.includes(ADAPTER_PATH)
    ).length;
  }
  return config.hooks[event].filter((block) =>
    block.hooks?.some((entry) =>
      `${entry.command ?? ""} ${entry.commandWindows ?? ""}`
        .replaceAll("\\", "/")
        .includes(ADAPTER_PATH.replaceAll("\\", "/"))
    )
  ).length;
}

test("install uses current Codex hooks format and preserves all three rich configs", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const codexPath = join(userProfile, ".codex", "hooks.json");
    const claudePath = join(userProfile, ".claude", "settings.json");
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const codexOriginal = {
      description: "existing Codex hooks",
      customTopLevel: { keep: true },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node existing-codex.mjs" }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify-codex.exe" }] }]
      }
    };
    const claudeOriginal = {
      model: "MiniMax-M2.1",
      env: {
        ANTHROPIC_BASE_URL: "https://api.minimax.example/v1",
        ANTHROPIC_AUTH_TOKEN: "keep-secret-reference"
      },
      plugins: { "existing-plugin": true },
      permissions: { allow: ["Read"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node existing-claude.mjs", timeout: 9 }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify.exe" }] }]
      }
    };
    const zcodeOriginal = {
      model: { provider: "unchanged-provider", name: "unchanged-model" },
      mcp: { filesystem: { command: "server.exe", args: ["D:\\data"] } },
      plugins: ["existing-zcode-plugin"],
      custom: { nested: [1, { keep: true }] },
      hooks: {
        enabled: false,
        events: {
          UserPromptSubmit: [{ type: "process", command: "node", args: ["existing-zcode.mjs"] }],
          AfterTool: [{ type: "process", command: "audit.exe", args: [] }]
        }
      }
    };
    const codexBytes = `${JSON.stringify(codexOriginal, null, 2)}\n`;
    const claudeBytes = `${JSON.stringify(claudeOriginal, null, 2)}\n`;
    const zcodeBytes = `${JSON.stringify(zcodeOriginal, null, 2)}\n`;
    await writeJson(codexPath, codexOriginal);
    await writeJson(claudePath, claudeOriginal);
    await writeJson(zcodePath, zcodeOriginal);

    const result = await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    const codex = await readJson(codexPath);
    assert.equal(codex.description, codexOriginal.description);
    assert.deepEqual(codex.customTopLevel, codexOriginal.customTopLevel);
    assert.deepEqual(codex.hooks.Notification, codexOriginal.hooks.Notification);
    assert.deepEqual(codex.hooks.UserPromptSubmit[0], codexOriginal.hooks.UserPromptSubmit[0]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(codex, event, "codex"), 1);
      const managed = codex.hooks[event].at(-1);
      assert.equal("matcher" in managed, false);
      assert.deepEqual(managed.hooks, [{
        type: "command",
        command: `node ${ADAPTER_PATH.replaceAll("\\", "/")} codex`,
        commandWindows: `node "${ADAPTER_PATH}" codex`,
        timeout: 5
      }]);
    }

    const claude = await readJson(claudePath);
    assert.equal(claude.model, claudeOriginal.model);
    assert.deepEqual(claude.env, claudeOriginal.env);
    assert.deepEqual(claude.plugins, claudeOriginal.plugins);
    assert.deepEqual(claude.permissions, claudeOriginal.permissions);
    assert.deepEqual(claude.hooks.Notification, claudeOriginal.hooks.Notification);
    assert.deepEqual(claude.hooks.UserPromptSubmit[0], claudeOriginal.hooks.UserPromptSubmit[0]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(claude, event, "claude"), 1);
      const managed = claude.hooks[event].at(-1);
      assert.equal("matcher" in managed, false);
      assert.deepEqual(managed.hooks, [{
        type: "command",
        command: `node "${ADAPTER_PATH}" claude`,
        timeout: 5
      }]);
    }

    const zcode = await readJson(zcodePath);
    assert.deepEqual(zcode.model, zcodeOriginal.model);
    assert.deepEqual(zcode.mcp, zcodeOriginal.mcp);
    assert.deepEqual(zcode.plugins, zcodeOriginal.plugins);
    assert.deepEqual(zcode.custom, zcodeOriginal.custom);
    assert.deepEqual(zcode.hooks.events.AfterTool, zcodeOriginal.hooks.events.AfterTool);
    assert.deepEqual(zcode.hooks.events.UserPromptSubmit[0], zcodeOriginal.hooks.events.UserPromptSubmit[0]);
    assert.equal(zcode.hooks.enabled, true);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(zcode, event, "zcode"), 1);
      assert.deepEqual(zcode.hooks.events[event].at(-1), {
        type: "process",
        command: "node",
        args: [ADAPTER_PATH, "zcode"],
        enabled: true,
        timeoutMs: 5000
      });
    }

    assert.deepEqual(result.changed.sort(), ["claude", "codex", "zcode"]);
    assert.equal(await readFile(join(result.backupDir, ".codex", "hooks.json"), "utf8"), codexBytes);
    assert.equal(await readFile(join(result.backupDir, ".claude", "settings.json"), "utf8"), claudeBytes);
    assert.equal(await readFile(join(result.backupDir, ".zcode", "cli", "config.json"), "utf8"), zcodeBytes);
  });
});

test("install creates missing configs, is idempotent, and does not add backups when nothing changes", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });
    const first = {
      codex: await readFile(join(userProfile, ".codex", "hooks.json"), "utf8"),
      claude: await readFile(join(userProfile, ".claude", "settings.json"), "utf8"),
      zcode: await readFile(join(userProfile, ".zcode", "cli", "config.json"), "utf8")
    };
    const backupRunsBefore = await listOrEmpty(join(runtimeDir, "backups"));

    const result = await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    assert.deepEqual(result.changed, []);
    assert.equal(result.backupDir, null);
    assert.deepEqual(await listOrEmpty(join(runtimeDir, "backups")), backupRunsBefore);
    assert.equal(await readFile(join(userProfile, ".codex", "hooks.json"), "utf8"), first.codex);
    assert.equal(await readFile(join(userProfile, ".claude", "settings.json"), "utf8"), first.claude);
    assert.equal(await readFile(join(userProfile, ".zcode", "cli", "config.json"), "utf8"), first.zcode);
    for (const [client, path] of [
      ["codex", join(userProfile, ".codex", "hooks.json")],
      ["claude", join(userProfile, ".claude", "settings.json")],
      ["zcode", join(userProfile, ".zcode", "cli", "config.json")]
    ]) {
      const config = await readJson(path);
      for (const event of ["UserPromptSubmit", "Stop"]) {
        assert.equal(managedCount(config, event, client), 1);
      }
    }
  });
});

test("uninstall removes only this exact adapter path and preserves later user changes", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    await installHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });
    const codexPath = join(userProfile, ".codex", "hooks.json");
    const claudePath = join(userProfile, ".claude", "settings.json");
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const codex = await readJson(codexPath);
    const claude = await readJson(claudePath);
    const zcode = await readJson(zcodePath);
    codex.hooks.Stop[0].hooks.push({ type: "command", command: "node retained-same-block.mjs" });
    codex.description = "added after install";
    codex.hooks.Stop.push({ hooks: [{ type: "command", command: "node D:/other/hook-cli.mjs codex" }] });
    claude.env = { MINIMAX_API_KEY: "still-present" };
    claude.hooks.Stop.push({ hooks: [{ type: "command", command: "node D:/other/hook-cli.mjs claude" }] });
    zcode.plugins = ["added-after-install"];
    zcode.hooks.events.Stop.push({ type: "process", command: "node", args: ["D:\\other\\hook-cli.mjs", "zcode"] });
    await writeJson(codexPath, codex);
    await writeJson(claudePath, claude);
    await writeJson(zcodePath, zcode);
    const beforeUninstall = {
      codex: await readFile(codexPath, "utf8"),
      claude: await readFile(claudePath, "utf8"),
      zcode: await readFile(zcodePath, "utf8")
    };

    const result = await uninstallHooks({ userProfile, runtimeDir, adapterPath: ADAPTER_PATH });

    const after = {
      codex: await readJson(codexPath),
      claude: await readJson(claudePath),
      zcode: await readJson(zcodePath)
    };
    assert.equal(after.codex.description, "added after install");
    assert.equal(after.claude.env.MINIMAX_API_KEY, "still-present");
    assert.deepEqual(after.zcode.plugins, ["added-after-install"]);
    for (const event of ["UserPromptSubmit", "Stop"]) {
      assert.equal(managedCount(after.codex, event, "codex"), 0);
      assert.equal(managedCount(after.claude, event, "claude"), 0);
      assert.equal(managedCount(after.zcode, event, "zcode"), 0);
    }
    assert.equal(after.codex.hooks.Stop.at(-1).hooks[0].command, "node D:/other/hook-cli.mjs codex");
    assert.equal(after.codex.hooks.Stop[0].hooks[0].command, "node retained-same-block.mjs");
    assert.equal(after.claude.hooks.Stop.at(-1).hooks[0].command, "node D:/other/hook-cli.mjs claude");
    assert.deepEqual(after.zcode.hooks.events.Stop.at(-1).args, ["D:\\other\\hook-cli.mjs", "zcode"]);
    assert.equal(await readFile(join(result.backupDir, ".codex", "hooks.json"), "utf8"), beforeUninstall.codex);
    assert.equal(await readFile(join(result.backupDir, ".claude", "settings.json"), "utf8"), beforeUninstall.claude);
    assert.equal(await readFile(join(result.backupDir, ".zcode", "cli", "config.json"), "utf8"), beforeUninstall.zcode);
  });
});

test("a rename failure leaves the existing Windows configuration unchanged and parseable", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const claudePath = join(userProfile, ".claude", "settings.json");
    const original = "{\r\n  \"model\": \"MiniMax-M2.1\",\r\n  \"env\": { \"KEEP\": \"yes\" }\r\n}\r\n";
    await mkdir(dirname(claudePath), { recursive: true });
    await writeFile(claudePath, original, "utf8");

    await assert.rejects(
      installHooks({
        client: "claude",
        userProfile,
        runtimeDir,
        adapterPath: ADAPTER_PATH,
        renameFile: async () => {
          const error = new Error("simulated Windows sharing violation");
          error.code = "EPERM";
          throw error;
        }
      }),
      /sharing violation/
    );

    const after = await readFile(claudePath, "utf8");
    assert.equal(after, original);
    assert.doesNotThrow(() => JSON.parse(after));
    const siblings = await readdir(dirname(claudePath));
    assert.deepEqual(siblings, ["settings.json"]);
    const backupRuns = await readdir(join(runtimeDir, "backups"));
    assert.equal(backupRuns.length, 1);
    assert.equal(
      await readFile(join(runtimeDir, "backups", backupRuns[0], ".claude", "settings.json"), "utf8"),
      original
    );
  });
});

test("malformed existing JSON is rejected without backup or replacement", async () => {
  await withSandbox(async ({ userProfile, runtimeDir }) => {
    const zcodePath = join(userProfile, ".zcode", "cli", "config.json");
    const malformed = "{ this is not json";
    await mkdir(dirname(zcodePath), { recursive: true });
    await writeFile(zcodePath, malformed, "utf8");

    await assert.rejects(
      installHooks({ client: "zcode", userProfile, runtimeDir, adapterPath: ADAPTER_PATH }),
      /Invalid JSON.*config\.json/
    );

    assert.equal(await readFile(zcodePath, "utf8"), malformed);
    await assert.rejects(readdir(join(runtimeDir, "backups")), { code: "ENOENT" });
  });
});
