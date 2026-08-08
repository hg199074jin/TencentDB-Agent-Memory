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

function timestampName(now) {
  return now().toISOString().replaceAll(":", "-");
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Unable to read local setup files");
  }
}

function parseLocalPort(source) {
  if (source === null) return 8420;
  const match = source.match(/^\s*MEMORY_CORE_PORT\s*=\s*([^\s#]+)\s*(?:#.*)?$/m);
  if (!match) return 8420;
  const port = Number(match[1].replace(/^['"]|['"]$/g, ""));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid local deployment MEMORY_CORE_PORT");
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
    throw new Error(
      "Fixed identity was rejected or the Gateway is unavailable; config was not written. " +
      "Start MemoryCore and confirm the current standalone Gateway accepts the fixed identity."
    );
  }
}

async function atomicWrite(path, source) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.bootstrap-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    JSON.parse(await readFile(temporaryPath, "utf8"));
    await rename(temporaryPath, path);
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
  gatewayFactory = (config) => new GatewayClient(config)
} = {}) {
  const root = resolve(adapterRoot);
  const configPath = join(root, "config.local.json");
  const original = await readOptional(configPath);

  if (original !== null && !force) {
    await loadConfig(root);
    throw new Error("config.local.json already exists; use --force to replace it after backup");
  }

  const keyPath = join(resolve(deployDir), ".admin-key");
  const rawCredential = await readOptional(keyPath);
  const apiKey = rawCredential?.trim() ?? "";
  if (!apiKey) {
    throw new Error("Missing local deployment credential: deploy/global-images/.admin-key");
  }
  const envSource = await readOptional(join(resolve(deployDir), ".env"));
  const port = parseLocalPort(envSource);
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
    await writeFile(backupPath, original, { encoding: "utf8", flag: "wx" });
  }

  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
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
  const result = await bootstrapConfig(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${formatBootstrapResult(result)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("[FAIL] 配置未写入：请确认 MemoryCore/Gateway 已启动且本地部署凭据存在。\n");
    process.exitCode = 1;
  });
}
