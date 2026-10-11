/**
 * opencode-cross-agent-memory.js — OpenCode 薄适配器（模型无关）。
 *
 * 安装：把本文件以软链接放入 ~/.config/opencode/plugin/（相对导入经软链接解析到
 * 本仓库源码），或按 docs/agent-memory/ARCHITECTURE.md 的安装步骤复制。
 *
 * 已适配 OpenCode 1.18.x 插件 API：
 *   chat.message / experimental.chat.system.transform / event(message.updated, session.idle)
 * 2.x 线若调整钩子签名，本文件做特征检测并降级（见 transformInjection 注释）。
 *
 * 双路径兼容：会话模型 provider 为 tencentdb-agent-memory（官方 Memory Proxy 适配）
 * 时插件完全静默——注入与写入由代理负责，避免双重注入/双写 L0。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureTurn } from "../src/capture.mjs";
import { loadConfig } from "../src/config.mjs";
import { CoreClient } from "../src/core-client.mjs";
import { TurnDedupe } from "../src/dedupe.mjs";
import { createIdentityPolicy, resolveScope } from "../src/identity.mjs";
import { Observability } from "../src/observability.mjs";
import { recallMemory } from "../src/recall.mjs";

const RUNTIME_DIR = join(
  process.env.AGENT_MEMORY_ROOT ?? fileURLToPath(new URL("../", import.meta.url)),
  "runtime",
);
const LOG_PATH = join(RUNTIME_DIR, "logs", "opencode-plugin.log");

/** 官方 Memory Proxy 适配的 provider ID：命中时代理已负责注入与 L0。 */
const PROXY_PROVIDER_ID = "tencentdb-agent-memory";

async function log(line) {
  try {
    await mkdir(join(RUNTIME_DIR, "logs"), { recursive: true });
    await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function userTextOf(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && !part?.synthetic && !part?.ignored)
    .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

export const CrossAgentMemory = async (input) => {
  const serverClient = input?.client;
  const observability = new Observability();
  const recallCache = new Map(); // sessionID → 最近召回块
  const lastUserMessage = new Map(); // sessionID → 最近用户消息 ID（turnId）
  const sessionProvider = new Map(); // sessionID → 最近模型 providerID

  let contextPromise = null;
  async function context() {
    if (!contextPromise) {
      contextPromise = (async () => {
        const config = await loadConfig();
        const policy = createIdentityPolicy({ config, allowed: config.allowed });
        const scope = resolveScope(policy, { client: "opencode" });
        if (!scope.ok) return { ok: false, reason: scope.reason };
        return {
          ok: true,
          config,
          identity: scope.identity,
          coreClient: new CoreClient({
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            serviceId: scope.identity.serviceId,
            isolation: {
              team_id: scope.identity.teamId,
              agent_id: scope.identity.agentId,
              user_id: scope.identity.userId,
              task_id: scope.identity.taskId,
            },
            timeoutMs: config.timeouts.recallMs,
          }),
          dedupe: new TurnDedupe({ stateDir: join(RUNTIME_DIR, "state") }),
        };
      })().catch(async (error) => {
        contextPromise = null;
        await log(`context build failed: ${error?.message ?? error}`);
        return { ok: false, reason: "config-error" };
      });
    }
    return contextPromise;
  }

  async function captureCurrentTurn(sessionID) {
    const built = await context();
    if (!built.ok) return { status: "skipped", reason: built.reason };
    const turnId = lastUserMessage.get(sessionID);
    if (!turnId) return { status: "skipped", reason: "no-turn" };
    if (sessionProvider.get(sessionID) === PROXY_PROVIDER_ID) return { status: "skipped", reason: "proxy-provider" };

    const messages = await fetchSessionMessages(sessionID);
    const entries = Array.isArray(messages) ? messages : [];
    const lastAssistant = [...entries].reverse().find((entry) => entry?.info?.role === "assistant" && entry?.info?.time?.completed);
    const userEntry = entries.find((entry) => entry?.info?.id === turnId);
    if (!lastAssistant || !userEntry) return { status: "skipped", reason: "turn-incomplete" };

    const result = await captureTurn({
      client: built.coreClient,
      identity: built.identity,
      dedupe: built.dedupe,
      observability,
      turn: {
        client: "opencode",
        provider: sessionProvider.get(sessionID) ?? "unknown",
        sessionId: sessionID,
        turnId,
        originalUser: userTextOf(userEntry.parts),
        finalAssistant: userTextOf(lastAssistant.parts),
        status: "completed",
      },
    });
    if (result.status !== "skipped") await log(`capture session=${sessionID} turn=${turnId} status=${result.status}`);
    return result;
  }

  async function fetchSessionMessages(sessionID) {
    // OpenCode 1.x 插件上下文自带 server client（input.client）
    if (!serverClient?.session?.messages) return null;
    try {
      const messages = await serverClient.session.messages({ path: { id: sessionID } });
      return messages?.data ?? messages ?? null;
    } catch (error) {
      await log(`session fetch failed: ${error?.message ?? error}`);
      return null;
    }
  }

  return {
    /** 用户消息到达：代理模型会话整体静默；否则先补写上一轮，再召回本轮。 */
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        if (input.model?.providerID) sessionProvider.set(sessionID, input.model.providerID);
        if (sessionProvider.get(sessionID) === PROXY_PROVIDER_ID) return;

        const currentID = input.messageID ?? output?.message?.id;
        const previousID = lastUserMessage.get(sessionID);
        if (previousID && previousID !== currentID) {
          await captureCurrentTurn(sessionID).catch(() => {});
        }
        if (currentID) lastUserMessage.set(sessionID, currentID);

        const userText = userTextOf(output.parts);
        if (!userText) return;
        const built = await context();
        if (!built.ok) return; // 身份不合法：不召回（fail-closed）

        const startedAt = Date.now();
        const { block, stats, degraded } = await recallMemory({
          client: built.coreClient,
          identity: built.identity,
          query: userText,
          policy: built.config.recall,
        });
        observability.recordRecall({ client: "opencode", ok: true, layers: stats, chars: stats.chars, elapsedMs: Date.now() - startedAt, degraded });
        recallCache.set(sessionID, block);
        await log(`recall session=${sessionID} chars=${block.length}`);
      } catch (error) {
        await log(`chat.message failed: ${error?.message ?? error}`);
      }
    },

    /** 注入：召回块追加进 system prompt。代理 provider 跳过（代理已注入）。 */
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (input?.model?.providerID === PROXY_PROVIDER_ID) return;
        const block = recallCache.get(input.sessionID);
        if (block) output.system.push(block);
      } catch (error) {
        await log(`system.transform failed: ${error?.message ?? error}`);
      }
    },

    /** 回合结束：assistant 完成 / 会话 idle → 写入本轮。 */
    event: async ({ event }) => {
      try {
        if (event?.type === "message.updated") {
          const info = event.properties?.info;
          if (info?.role !== "assistant" || !info?.time?.completed) return;
          if (info.providerID === PROXY_PROVIDER_ID) return;
          if (!lastUserMessage.get(info.sessionID)) return;
          await captureCurrentTurn(info.sessionID);
          return;
        }
        if (event?.type === "session.idle") {
          const sessionID = event.properties?.sessionID;
          if (!sessionID) return;
          if (sessionProvider.get(sessionID) === PROXY_PROVIDER_ID) return;
          await captureCurrentTurn(sessionID);
        }
      } catch (error) {
        await log(`event failed: ${error?.message ?? error}`);
      }
    },
  };
};
