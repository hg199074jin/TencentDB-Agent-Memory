import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXED_IDENTITY,
  bootstrapConfig,
  formatBootstrapResult
} from "../src/bootstrap-config.mjs";

const BOOTSTRAP_CLI = fileURLToPath(new URL("../src/bootstrap-config.mjs", import.meta.url));

async function withSandbox(run, { remove = rm } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-bootstrap-"));
  let primaryError;
  try {
    await run({
      adapterRoot: join(root, "integrations", "cross-agent-memory"),
      deployDir: join(root, "deploy", "global-images")
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await remove(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "sandbox body and cleanup both failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function runCli({ adapterRoot, deployDir, args = [] }) {
  const child = spawn(process.execPath, [BOOTSTRAP_CLI, ...args], {
    env: {
      ...process.env,
      CROSS_AGENT_MEMORY_TEST_MODE: "1",
      CROSS_AGENT_MEMORY_TEST_ADAPTER_ROOT: adapterRoot,
      CROSS_AGENT_MEMORY_TEST_DEPLOY_DIR: deployDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function withGateway(handler, run) {
  const server = createServer(handler);
  let primaryError;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await run(server.address().port);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    server.close();
    await once(server, "close");
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError]);
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

test("secured bootstrap uses the Gateway Bearer from .env and never the admin user_key", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const credential = "gateway-bearer-test-placeholder";
    const adminUserKey = "admin-user-key-must-not-be-used";
    await writeText(join(deployDir, ".admin-key"), adminUserKey);
    await writeText(join(deployDir, ".env"), `MEMORY_CORE_GATEWAY_API_KEY=${credential}\n`);
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
    assert.equal(formatBootstrapResult(result).includes(adminUserKey), false);
    assert.equal(result.credentialMode, "gateway-bearer");
  });
});

test("explicitly disabled Bearer gate uses a non-secret local compatibility fallback", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".admin-key"), "admin-user-key-not-bearer");
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY= # explicitly disabled for local proxy compatibility\n");
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
    assert.equal(result.credentialMode, "bearer-disabled-local-fallback");
    assert.equal(config.apiKey, verifiedConfig.apiKey);
    assert.match(config.apiKey, /bearer.*disabled|disabled.*bearer/i);
    assert.equal(config.apiKey.includes("admin-user-key-not-bearer"), false);
    assert.match(formatBootstrapResult(result), /Bearer gate 已显式关闭/);
    assert.equal(formatBootstrapResult(result).includes("认证材料已配置"), false);
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
    const original = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0d, 0x0a]);
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=replacement-test-placeholder\n");

    const result = await bootstrapConfig({
      adapterRoot,
      deployDir,
      force: true,
      now: () => new Date("2026-08-08T01:02:03.000Z"),
      gatewayFactory: () => ({ readCore: async () => ({}) })
    });

    assert.equal(result.status, "REPLACED");
    assert.ok(result.backupPath);
    assert.deepEqual(await readFile(result.backupPath), original);
    assert.notDeepEqual(await readFile(join(adapterRoot, "config.local.json")), original);
  });
});

test("a rename failure preserves the original parseable config and its exact backup", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const original = Buffer.from(`${JSON.stringify({
      endpoint: "http://127.0.0.1:8420",
      apiKey: "old-test-placeholder",
      serviceId: "default",
      identity: FIXED_IDENTITY
    }, null, 2)}\r\n`, "utf8");
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=new-test-placeholder\n");
    const now = () => new Date("2026-08-08T02:03:04.000Z");

    await assert.rejects(bootstrapConfig({
      adapterRoot,
      deployDir,
      force: true,
      now,
      gatewayFactory: () => ({ readCore: async () => ({}) }),
      renameFile: async () => { throw new Error("simulated rename failure"); }
    }), /replace local config/i);

    const after = await readFile(join(adapterRoot, "config.local.json"));
    assert.deepEqual(after, original);
    JSON.parse(after.toString("utf8"));
    const backupPath = join(
      adapterRoot,
      "runtime",
      "backups",
      `bootstrap-2026-08-08T02-03-04.000Z-${process.pid}`,
      "config.local.json"
    );
    assert.deepEqual(await readFile(backupPath), original);
  });
});

test("bootstrap stops actionably when the deployment .env or Gateway key declaration is missing", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir }),
      /deployment.*\.env/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });

    await writeText(join(deployDir, ".env"), "MEMORY_CORE_PORT=8420\n");
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir }),
      /MEMORY_CORE_GATEWAY_API_KEY.*explicit/i
    );
  });
});

test("malformed Gateway key declarations fail without exposing Gateway or admin secrets", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    const gatewaySecret = "unterminated-gateway-secret";
    const adminSecret = "admin-user-secret";
    await writeText(join(deployDir, ".admin-key"), adminSecret);
    await writeText(join(deployDir, ".env"), `MEMORY_CORE_GATEWAY_API_KEY="${gatewaySecret}\n`);

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir }),
      (error) => /MEMORY_CORE_GATEWAY_API_KEY.*invalid/i.test(error.message) &&
        !error.message.includes(gatewaySecret) && !error.message.includes(adminSecret)
    );
  });
});

test("bootstrap verifies strict isolation before writing and leaves no config on failure", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=verification-test-placeholder\n");
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

test("bootstrap CLI emits exact actionable sanitized results for success and four failure categories", async () => {
  await withGateway((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v3/core/read") {
      response.end(JSON.stringify({ code: 0, message: "ok", request_id: "test-request", data: {} }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  }, async (port) => {
    await withSandbox(async ({ adapterRoot, deployDir }) => {
      const credential = "cli-success-test-placeholder";
      const adminUserKey = "cli-admin-user-key";
      await writeText(join(deployDir, ".admin-key"), adminUserKey);
      await writeText(join(deployDir, ".env"), `MEMORY_CORE_PORT=${port}\nMEMORY_CORE_GATEWAY_API_KEY=${credential}\n`);
      const result = await runCli({ adapterRoot, deployDir });
      assert.deepEqual(result, {
        code: 0,
        stdout: "[CREATED] 本机共享记忆配置已验证并写入，认证材料已配置但不会显示\n",
        stderr: ""
      });
      assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(adminUserKey), false);
    });
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(adapterRoot, "config.local.json"), `${JSON.stringify({
      endpoint: "http://127.0.0.1:8420",
      apiKey: "existing-cli-test-placeholder",
      serviceId: "default",
      identity: FIXED_IDENTITY
    })}\n`);
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1,
      stdout: "",
      stderr: "[FAIL] 配置未写入：config.local.json 已存在；如需替换请使用 --force。\n"
    });
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1,
      stdout: "",
      stderr: "[FAIL] 配置未写入：缺少本地部署配置 deploy/global-images/.env。\n"
    });
  });

  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_PORT=not-a-port\nMEMORY_CORE_GATEWAY_API_KEY=\n");
    assert.deepEqual(await runCli({ adapterRoot, deployDir }), {
      code: 1,
      stdout: "",
      stderr: "[FAIL] 配置未写入：本地 Gateway 端口配置无效。\n"
    });
  });

  await withGateway((_request, response) => {
    response.statusCode = 403;
    response.end("sensitive response body");
  }, async (port) => {
    await withSandbox(async ({ adapterRoot, deployDir }) => {
      const credential = "gateway-reject-test-placeholder";
      const adminUserKey = "gateway-reject-admin-user-key";
      await writeText(join(deployDir, ".admin-key"), adminUserKey);
      await writeText(join(deployDir, ".env"), `MEMORY_CORE_PORT=${port}\nMEMORY_CORE_GATEWAY_API_KEY=${credential}\n`);
      const result = await runCli({ adapterRoot, deployDir });
      assert.deepEqual(result, {
        code: 1,
        stdout: "",
        stderr: "[FAIL] 配置未写入：MemoryCore/Gateway 不可用或拒绝固定身份。\n"
      });
      assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(adminUserKey), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes("sensitive response body"), false);
    });
  });
});

test("bootstrap sandbox preserves both a primary failure and a cleanup failure", async () => {
  const primary = new Error("primary test failure");
  const cleanup = new Error("cleanup test failure");
  await assert.rejects(
    withSandbox(async () => { throw primary; }, { remove: async () => { throw cleanup; } }),
    (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup
  );
});
