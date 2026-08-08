import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  FIXED_IDENTITY,
  bootstrapConfig,
  formatBootstrapResult
} from "../src/bootstrap-config.mjs";

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-bootstrap-"));
  try {
    await run({
      adapterRoot: join(root, "integrations", "cross-agent-memory"),
      deployDir: join(root, "deploy", "global-images")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

test("bootstrap reads only the local deployment credential and writes the fixed shared identity", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const credential = "test-only-placeholder";
    await writeText(join(deployDir, ".admin-key"), credential);
    let verifiedConfig;

    const result = await bootstrapConfig({
      adapterRoot,
      deployDir,
      gatewayFactory(config) {
        verifiedConfig = config;
        return { readCore: async () => ({}) };
      }
    });

    const config = JSON.parse(await readFile(join(adapterRoot, "config.local.json"), "utf8"));
    assert.equal(result.status, "CREATED");
    assert.equal(config.endpoint, "http://127.0.0.1:8420");
    assert.equal(config.serviceId, "default");
    assert.equal(config.apiKey, credential);
    assert.deepEqual(config.identity, {
      teamId: "team-personal-memory",
      agentId: "agent-personal-assistant",
      userId: "user-jin-z",
      taskId: "task-cross-agent-chat"
    });
    assert.deepEqual(verifiedConfig.identity, FIXED_IDENTITY);
    assert.equal(formatBootstrapResult(result).includes(credential), false);
  });
});

test("bootstrap validates but refuses to overwrite an existing config without force", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = `${JSON.stringify({
      endpoint: "http://127.0.0.1:8420",
      apiKey: "existing-test-placeholder",
      serviceId: "default",
      identity: FIXED_IDENTITY
    }, null, 2)}\n`;
    await writeText(join(adapterRoot, "config.local.json"), original);

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir }),
      /already exists.*--force/i
    );
    assert.equal(await readFile(join(adapterRoot, "config.local.json"), "utf8"), original);
  });
});

test("force backs up the exact original bytes before replacing the config", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = "{\r\n  \"old\": true\r\n}\r\n";
    await writeText(join(adapterRoot, "config.local.json"), original);
    await writeText(join(deployDir, ".admin-key"), "replacement-test-placeholder");

    const result = await bootstrapConfig({
      adapterRoot,
      deployDir,
      force: true,
      now: () => new Date("2026-08-08T01:02:03.000Z"),
      gatewayFactory: () => ({ readCore: async () => ({}) })
    });

    assert.equal(result.status, "REPLACED");
    assert.ok(result.backupPath);
    assert.equal(await readFile(result.backupPath, "utf8"), original);
    assert.notEqual(await readFile(join(adapterRoot, "config.local.json"), "utf8"), original);
  });
});

test("bootstrap stops without guessing when the deployment credential is missing", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir }),
      /deployment credential.*\.admin-key/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});

test("bootstrap verifies strict isolation before writing and leaves no config on failure", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".admin-key"), "verification-test-placeholder");
    await assert.rejects(
      bootstrapConfig({
        adapterRoot,
        deployDir,
        gatewayFactory: () => ({ readCore: async () => { throw new Error("rejected"); } })
      }),
      /fixed identity.*Gateway/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });
  });
});
