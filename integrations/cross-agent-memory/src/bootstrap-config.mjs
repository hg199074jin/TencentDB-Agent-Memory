import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";

const DEFAULT_ADAPTER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_DEPLOY_DIR = resolve(DEFAULT_ADAPTER_ROOT, "..", "..", "deploy", "global-images");

export const FIXED_IDENTITY = Object.freeze({
  teamId: "team-personal-memory",
  agentId: "agent-personal-assistant",
  userId: "user-jin-z",
  taskId: "task-cross-agent-chat"
});

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

function timestampName(now) {
  return now().toISOString().replaceAll(":", "-");
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new BootstrapError("local-files", "Unable to read local setup files");
  }
}

function parseLocalPort(source) {
  if (source === null) return 8420;
  const match = source.match(/^\s*MEMORY_CORE_PORT\s*=\s*([^\s#]+)\s*(?:#.*)?$/m);
  if (!match) return 8420;
  const port = Number(match[1].replace(/^['"]|['"]$/g, ""));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BootstrapError("invalid-port", "Invalid local deployment MEMORY_CORE_PORT");
  }
  return port;
}

function makeConfig({ endpoint, apiKey }) {
  return {
    endpoint,
    apiKey,
    serviceId: "default",
    identity: { ...FIXED_IDENTITY },
    timeouts: { recallMs: 1200, captureMs: 3000 },
    recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 12000 },
    queue: { retryBatchSize: 3, retryBudgetMs: 800 }
  };
}

async function verifyFixedIdentity(config, gatewayFactory) {
  try {
    const gateway = gatewayFactory(config);
    await gateway.readCore();
  } catch {
    throw new BootstrapError(
      "gateway",
      "Fixed identity was rejected or the Gateway is unavailable; config was not written. " +
      "Start MemoryCore and confirm the current standalone Gateway accepts the fixed identity."
    );
  }
}

async function atomicWrite(path, source, renameFile) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.bootstrap-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    JSON.parse(await readFile(temporaryPath, "utf8"));
    try {
      await renameFile(temporaryPath, path);
    } catch {
      throw new BootstrapError("replace-failed", "Unable to replace local config; original remains unchanged");
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function bootstrapConfig({
  adapterRoot = DEFAULT_ADAPTER_ROOT,
  deployDir = DEFAULT_DEPLOY_DIR,
  force = false,
  now = () => new Date(),
  gatewayFactory = (config) => new GatewayClient(config),
  renameFile = rename
} = {}) {
  const root = resolve(adapterRoot);
  const configPath = join(root, "config.local.json");
  const original = await readOptional(configPath);

  if (original !== null && !force) {
    try {
      await loadConfig(root);
    } catch {
      throw new BootstrapError(
        "existing-config",
        "config.local.json already exists but is invalid; use --force to replace it after backup"
      );
    }
    throw new BootstrapError(
      "existing-config",
      "config.local.json already exists; use --force to replace it after backup"
    );
  }

  const keyPath = join(resolve(deployDir), ".admin-key");
  const rawCredential = await readOptional(keyPath);
  const apiKey = rawCredential?.toString("utf8").trim() ?? "";
  if (!apiKey) {
    throw new BootstrapError(
      "missing-credential",
      "Missing local deployment credential: deploy/global-images/.admin-key"
    );
  }
  const envSource = await readOptional(join(resolve(deployDir), ".env"));
  const port = parseLocalPort(envSource?.toString("utf8") ?? null);
  const config = makeConfig({ endpoint: `http://127.0.0.1:${port}`, apiKey });

  await verifyFixedIdentity(config, gatewayFactory);

  let backupPath = null;
  if (original !== null) {
    backupPath = join(
      root,
      "runtime",
      "backups",
      `bootstrap-${timestampName(now)}-${process.pid}`,
      "config.local.json"
    );
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, original, { flag: "wx" });
  }

  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, renameFile);
  return {
    status: original === null ? "CREATED" : "REPLACED",
    configPath,
    backupPath,
    identity: { ...FIXED_IDENTITY }
  };
}

export function formatBootstrapResult(result) {
  const backup = result.backupPath ? "；原配置已备份到 D 盘 runtime" : "";
  return `[${result.status}] 本机共享记忆配置已验证并写入，认证材料已配置但不会显示${backup}`;
}

function parseArguments(argv) {
  let force = false;
  for (const argument of argv) {
    if (argument === "--force") force = true;
    else throw new Error("Usage: bootstrap-config.mjs [--force]");
  }
  return { force };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  // These path overrides are intentionally test-only. They carry no credentials
  // and are ignored unless the explicit test-mode guard is present.
  const testPaths = process.env.CROSS_AGENT_MEMORY_TEST_MODE === "1"
    ? {
        adapterRoot: process.env.CROSS_AGENT_MEMORY_TEST_ADAPTER_ROOT,
        deployDir: process.env.CROSS_AGENT_MEMORY_TEST_DEPLOY_DIR
      }
    : {};
  const result = await bootstrapConfig({
    ...parsed,
    ...Object.fromEntries(Object.entries(testPaths).filter(([, value]) => value))
  });
  process.stdout.write(`${formatBootstrapResult(result)}\n`);
}

function bootstrapFailureMessage(error) {
  const messages = {
    "existing-config": "[FAIL] 配置未写入：config.local.json 已存在；如需替换请使用 --force。",
    "missing-credential": "[FAIL] 配置未写入：缺少本地部署凭据 .admin-key。",
    "invalid-port": "[FAIL] 配置未写入：本地 Gateway 端口配置无效。",
    gateway: "[FAIL] 配置未写入：MemoryCore/Gateway 不可用或拒绝固定身份。",
    "replace-failed": "[FAIL] 配置未写入：无法原子替换文件，原配置保持不变。",
    "local-files": "[FAIL] 配置未写入：本地配置文件不可读取。"
  };
  return messages[error?.code] ?? "[FAIL] 配置未写入：发生本地设置错误，未显示配置内容。";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${bootstrapFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
