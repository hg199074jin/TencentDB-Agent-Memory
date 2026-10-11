/**
 * capture.mjs — 完整回合捕获（M1 准确性契约）。
 *
 * 规则：
 *   - 只捕获 status === 'completed' 且 finalAssistant 非空的回合
 *     （cancelled / failed / 空 final 不伪造"完整一轮"）；
 *   - 用户文本先剥离已注入记忆块，再过隐私检查（opt-out / 凭据 / data-uri）；
 *   - 角色被限制为 user + assistant 一对；工具流、中间片段、注入历史块不会进入 L0；
 *   - 写入经 TurnDedupe：写前读回 + ACK 状态机 + unknown 不盲目重试；
 *   - 一条消息长度超限时显式跳过并回报（不悄悄截断——隐私净化后的截断仅对
 *     明显超长的二进制噪声生效，语义见 privacy.sanitizeText）。
 */

import { inspectTurn } from "./privacy.mjs";
import { memorySessionIdFor, turnKey } from "./dedupe.mjs";
import { drainCaptureQueue } from "./state-store.mjs";

const USER_LIMIT = 30_000;
const ASSISTANT_LIMIT = 60_000;

/** 读回判重：服务端已存在同 (role, content) 的一对消息即视为已写。 */
export function alreadyStored(existing, userText, assistantText) {
  const messages = Array.isArray(existing?.messages) ? existing.messages : [];
  const used = new Set();
  return [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ].every((queued) => {
    const index = messages.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      return candidate?.role === queued.role && candidate?.content === queued.content;
    });
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

/**
 * @param {{ client: object, identity: object, turn: object, dedupe: object,
 *           observability?: object, now?: () => Date }} input
 * @returns {Promise<{status:string, key?:string, sessionId?:string, reason?:string}>}
 */
export async function captureTurn({ client, identity, turn, dedupe, observability, now = () => new Date() }) {
  const startedAt = Date.now();
  const finish = (result) => {
    observability?.recordCapture({
      client: turn.client,
      status: result.status,
      elapsedMs: Date.now() - startedAt,
      errorClass: result.reason,
    });
    return result;
  };

  if (turn.status !== "completed") {
    return finish({ status: "skipped", reason: "turn-not-completed" });
  }
  if (typeof turn.finalAssistant !== "string" || turn.finalAssistant.trim() === "") {
    return finish({ status: "skipped", reason: "empty-final-assistant" });
  }
  if (typeof turn.originalUser !== "string" || turn.originalUser.trim() === "") {
    return finish({ status: "skipped", reason: "empty-user-text" });
  }

  const inspected = inspectTurn(turn.originalUser, turn.finalAssistant);
  if (inspected.skip) {
    return finish({ status: "skipped", reason: "privacy" });
  }
  if (inspected.user.length === 0 || inspected.assistant.length === 0) {
    return finish({ status: "skipped", reason: "empty-after-sanitize" });
  }
  if (inspected.user.length >= USER_LIMIT || inspected.assistant.length >= ASSISTANT_LIMIT) {
    return finish({ status: "skipped", reason: "message-too-long" });
  }

  const key = turnKey({
    serviceId: identity.serviceId,
    teamId: identity.teamId,
    userId: identity.userId,
    agentId: identity.agentId,
    client: turn.client,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
  });
  const memorySessionId = memorySessionIdFor(turn.client, turn.sessionId);
  const timestamp = now().toISOString();
  const messages = [
    { role: "user", content: inspected.user, timestamp },
    { role: "assistant", content: inspected.assistant, timestamp },
  ];

  const verify = async () => {
    try {
      const existing = await client.queryConversation({ sessionId: memorySessionId, limit: 20 });
      return alreadyStored(existing, inspected.user, inspected.assistant);
    } catch {
      return false;
    }
  };

  const result = await dedupe.execute({
    key,
    sessionId: memorySessionId,
    messages,
    verify,
    send: ({ sessionId }) => client.addConversation({ sessionId, messages }),
  });

  return finish({ status: result.status, key, sessionId: memorySessionId, messages, reason: result.reason });
}

/**
 * 重试本地 spool 中"发送前失败"的写入（带去重感知）。
 * 规则：acknowledged → 出队（已写入）；unknown → 出队（不盲目重试）；
 * pending → 重发，仍失败则留在队列等待下次。
 */
export async function retryQueuedCaptures({
  coreClient,
  dedupe,
  runtimeDir,
  retryBatchSize = 3,
  retryBudgetMs = 800,
  deadline = Number.POSITIVE_INFINITY,
}) {
  const startedAt = Date.now();
  const hasBudget = () => Date.now() - startedAt < retryBudgetMs && Date.now() < deadline;
  const processed = await drainCaptureQueue(
    retryBatchSize,
    async (record) => {
      if (!hasBudget()) return false;
      const key = record?.turnKey;
      if (key) {
        const state = dedupe.stateOf(key);
        if (state === "acknowledged" || state === "unknown") return true; // 出队，不重发
      }
      // 写前读回：服务端已有同内容则不重发；读回失败/超时 → 保持队列（不盲发）
      try {
        const existing = await coreClient.queryConversation({ sessionId: record.memorySessionId, limit: 20 });
        const messages = Array.isArray(record?.messages) ? record.messages : [];
        if (messages.length > 0 && messages.every((queued) =>
          (existing?.messages ?? []).some((candidate) => candidate?.role === queued.role && candidate?.content === queued.content))) {
          if (key) await dedupe.markAcknowledged(key, { via: "spool-read-back" });
          return true;
        }
      } catch {
        return false; // 无法验证是否已写入：保留在队列，下次重试
      }
      try {
        await coreClient.addConversation({ sessionId: record.memorySessionId, messages: record.messages });
        if (key) await dedupe.markAcknowledged(key, { via: "spool-retry" });
        return true;
      } catch {
        return false; // 保留在队列
      }
    },
    { runtimeDir },
  );
  return { processed, budgetExceeded: !hasBudget() };
}
