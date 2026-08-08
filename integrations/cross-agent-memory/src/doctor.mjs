import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_ADAPTER_PATH = fileURLToPath(new URL("./hook-cli.mjs", import.meta.url));
const EVENTS = ["UserPromptSubmit", "Stop"];

function pass(name, detail) {
  return { name, status: "PASS", detail };
}

function fail(name, detail) {
  return { name, status: "FAIL", detail };
}

function nodeSupported(version) {
  const [major, minor] = String(version).split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) &&
    (major > 22 || (major === 22 && minor >= 16));
}

async function safeCheck(name, operation, successDetail, failureDetail) {
  try {
    await operation();
    return pass(name, successDetail);
  } catch {
    return fail(name, failureDetail);
  }
}

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

function normalizedCommand(value) {
  return normalizedPath(value).trim();
}

function validHandler(entry, adapterPath, client) {
  if (entry === null || typeof entry !== "object") return false;
  const path = resolve(adapterPath);
  if (client === "zcode") {
    return entry.type === "process" &&
      entry.command === "node" &&
      Array.isArray(entry.args) &&
      entry.args.length === 2 &&
      normalizedPath(entry.args[0]) === normalizedPath(path) &&
      entry.args[1] === "zcode" &&
      entry.enabled === true &&
      entry.timeoutMs === 5000;
  }
  if (entry.type !== "command" || entry.timeout !== 5) return false;
  if (client === "codex") {
    return normalizedCommand(entry.command) === normalizedCommand(`node ${path.replaceAll("\\", "/")} codex`) &&
      normalizedCommand(entry.commandWindows) === normalizedCommand(`node "${path}" codex`);
  }
  return normalizedCommand(entry.command) === normalizedCommand(`node "${path}" claude`);
}

function groupRegistered(group, adapterPath, client) {
  return Array.isArray(group?.hooks) && group.hooks.some((entry) => validHandler(entry, adapterPath, client));
}

export function isClientHookConfigRegistered(config, client, adapterPath = DEFAULT_ADAPTER_PATH) {
  if (!(["codex", "claude", "zcode"].includes(client))) return false;
  if (client === "zcode") {
    if (config?.hooks?.enabled !== true) return false;
    return EVENTS.every((event) =>
      Array.isArray(config?.hooks?.events?.[event]) &&
      config.hooks.events[event].some((group) => groupRegistered(group, adapterPath, client))
    );
  }
  return EVENTS.every((event) =>
    Array.isArray(config?.hooks?.[event]) &&
    config.hooks[event].some((group) => groupRegistered(group, adapterPath, client))
  );
}

async function readJson(path) {
  const source = await readFile(path, "utf8");
  const parsed = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  return parsed;
}

async function hookRegistered({ client, userProfile, adapterPath }) {
  const configPath = client === "codex"
    ? join(userProfile, ".codex", "hooks.json")
    : client === "claude"
      ? join(userProfile, ".claude", "settings.json")
      : join(userProfile, ".zcode", "cli", "config.json");
  const config = await readJson(configPath);
  return isClientHookConfigRegistered(config, client, adapterPath);
}

async function defaultHealthCheck(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeouts.recallMs, 1200));
  try {
    const response = await fetch(`${config.endpoint}/health`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "x-tdai-service-id": config.serviceId
      }
    });
    if (!response.ok) throw new Error("unavailable");
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor({
  rootDir = DEFAULT_ROOT_DIR,
  userProfile = process.env.USERPROFILE || process.env.HOME || homedir(),
  adapterPath = DEFAULT_ADAPTER_PATH,
  nodeVersion = process.versions.node,
  write = false,
  healthCheck = defaultHealthCheck,
  gatewayFactory = (config) => new GatewayClient(config)
} = {}) {
  const checks = [];
  let config;
  let gateway;
  try {
    config = await loadConfig(rootDir);
    gateway = gatewayFactory(config);
    checks.push(pass("config", "本机配置完整"));
  } catch {
    checks.push(fail("config", "本机配置不可用"));
  }

  checks.push(nodeSupported(nodeVersion)
    ? pass("node", `Node ${nodeVersion} 可用`)
    : fail("node", "需要 Node 22.16 或更高版本"));

  if (!config || !gateway) {
    checks.push(fail("gateway", "无法在配置缺失时检查 Gateway"));
    checks.push(fail("l0", "无法在配置缺失时检查 L0"));
    checks.push(fail("l1", "无法在配置缺失时检查 L1"));
    checks.push(fail("l3", "无法在配置缺失时检查 L3"));
    checks.push(fail("write", "无法在配置缺失时检查写入"));
  } else {
    checks.push(await safeCheck(
      "gateway",
      () => healthCheck(config),
      "MemoryCore Gateway 可连接",
      "MemoryCore Gateway 不可连接"
    ));
    checks.push(await safeCheck(
      "l0",
      () => gateway.searchConversation("cross-agent-memory-doctor", 1),
      "L0 查询可用",
      "L0 查询失败"
    ));
    checks.push(await safeCheck(
      "l1",
      () => gateway.searchAtomic("cross-agent-memory-doctor", 1),
      "L1 查询可用",
      "L1 查询失败"
    ));
    checks.push(await safeCheck(
      "l3",
      () => gateway.readCore(),
      "L3 读取可用",
      "L3 读取失败"
    ));
    if (!write) {
      checks.push(pass("write", "可选写入测试未启用"));
    } else {
      const timestamp = new Date().toISOString();
      checks.push(await safeCheck(
        "write",
        () => gateway.addConversation("doctor-connectivity-check", [
          { role: "user", content: "cross-agent-memory-doctor", timestamp },
          { role: "assistant", content: "doctor-ok", timestamp }
        ]),
        "可选写入测试成功",
        "可选写入测试失败"
      ));
    }
  }

  for (const client of ["codex", "claude", "zcode"]) {
    checks.push(await safeCheck(
      `hook-${client}`,
      async () => {
        if (!await hookRegistered({ client, userProfile, adapterPath })) throw new Error("missing");
      },
      `${client} 的两个 Hook 已注册`,
      `${client} Hook 未完整注册`
    ));
  }
  return checks;
}

export function formatDoctorReport(checks) {
  return checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`).join("\n");
}

function parseArguments(argv) {
  let write = false;
  for (const argument of argv) {
    if (argument === "--write") write = true;
    else throw new Error("Usage: doctor.mjs [--write]");
  }
  return { write };
}

async function main() {
  const checks = await runDoctor(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${formatDoctorReport(checks)}\n`);
  if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("[FAIL] doctor: 诊断程序无法完成；未显示配置或对话内容。\n");
    process.exitCode = 1;
  });
}
