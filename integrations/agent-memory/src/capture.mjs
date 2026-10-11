/**
 * capture.mjs — 完整回合捕获（R2 收口）。
 *
 * 规则：
 *   - 只捕获 status === 'completed' 且 finalAssistant 非空的回合；
 *   - 用户文本先剥离已注入记忆块，再过隐私检查；
 *   - 角色限制为 user + assistant 一对；
 *   - 长度：单条消息 ≤8192 码点（官方 v3-api §conversation/add）——
 *     超限**跳过捕获并给出结构化 reason**，不悄悄截断；
 *   - 幂等：turnKey 为唯一主判据。写前**不再**用内容匹配自动确认
 *     （同内容不同 turn 是真实历史，P1-E）；内容匹配仅用于
 *     reconcile/spool 的"疑似重复"辅助判断；
 *   - 发送结果按 delivery 分类流转：retryable→spool；unknown→保留待对账；
 *     deferred→保留 pending 下次重试；denied→不重试。
 */

import { inspectTurn } from "./privacy.mjs";
import { memorySessionIdFor, turnKey } from "./dedupe.mjs";
import { drainCaptureQueue } from "./state-store.mjs";
import { MAX_MESSAGE_CODE_POINTS } from "./core-client.mjs";

function codePointLength(value) {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/**
 * 读回判重：服务端已存在同 (role, content) 的一对消息即视为"疑似已写"。
 * ⚠️ 仅作辅助信号：不同 turn 的相同问答是真实历史，不得据此跳过新 turn。
 */
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

  if (turn.status !== "completed") return finish({ status: "skipped", reason: "turn-not-completed" });
  if (typeof turn.finalAssistant !== "string" || turn.finalAssistant.trim() === "") {
    return finish({ status: "skipped", reason: "empty-final-assistant" });
  }
  if (typeof turn.originalUser !== "string" || turn.originalUser.trim() === "") {
    return finish({ status: "skipped", reason: "empty-user-text" });
  }

  const inspected = inspectTurn(turn.originalUser, turn.finalAssistant);
  if (inspected.skip) return finish({ status: "skipped", reason: "privacy" });
  if (inspected.user.length === 0 || inspected.assistant.length === 0) {
    return finish({ status: "skipped", reason: "empty-after-sanitize" });
  }
  // 官方 v3 限制：单条消息 1–8192 码点；超限跳过（不悄悄截断语义）
  for (const [role, text] of [["user", inspected.user], ["assistant", inspected.assistant]]) {
    if (codePointLength(text) > MAX_MESSAGE_CODE_POINTS) {
      return finish({ status: "skipped", reason: "message-too-long" });
    }
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

  // turnKey 是唯一主判据：不做写前内容匹配（P1-E）。
  const result = await dedupe.execute({
    key,
    sessionId: memorySessionId,
    messages,
    send: ({ sessionId }) => client.addConversation({ sessionId, messages }),
  });

  return finish({ status: result.status, key, sessionId: memorySessionId, messages, reason: result.reason });
}

/**
 * spool 重试（带去重感知）：
 *   acknowledged → 出队；
 *   unknown → 读回：疑似已写 → 标记 acknowledged(suspected) 出队；未找到 → 保留（不盲发）；
 *   pending/无状态 → 读回疑似已写出队；否则重发；
 *   重发失败：definitely_not_sent → 保留；maybe_sent → unknown 保留；rejected → 出队并记账。
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
  const stats = { resent: 0, droppedSuspected: 0, droppedAck: 0, keptUnknown: 0, droppedRejected: 0, suspectedLegacy: 0, suspectedUnknown: 0, suspectedResend: 0 };

  const readBack = async (record) => {
    try {
      const existing = await coreClient.queryConversation({ sessionId: record.memorySessionId, limit: 100 });
      const messages = Array.isArray(record?.messages) ? record.messages : [];
      return messages.length > 0 && alreadyStored(existing, messages[0]?.content, messages[1]?.content);
    } catch {
      return null; // 读回失败：无法判断
    }
  };

  const processed = await drainCaptureQueue(
    retryBatchSize,
    async (record) => {
      if (!hasBudget()) return false;
      const key = record?.turnKey;

      // R3 契约：队列记录**强制 turnKey**。无 key 的历史记录无法证明归属，
      // 内容匹配只能报告"疑似"，绝不出队、绝不盲发（保留待人工/迁移处理）。
      if (!key) {
        const suspected = await readBack(record);
        if (suspected === true) stats.suspectedLegacy += 1;
        stats.keptUnknown += 1;
        return false;
      }

      const state = dedupe.stateOf(key);
      if (state === "acknowledged") {
        stats.droppedAck += 1;
        return true; // 只有该 key 的真实 durable ACK 才自动出队
      }
      if (state === "denied") {
        stats.droppedRejected += 1;
        return true;
      }
      if (state === "unknown") {
        const suspected = await readBack(record);
        if (suspected === true) stats.suspectedUnknown += 1; // 仅报告，不升级、不删除
        stats.keptUnknown += 1;
        return false;
      }

      // pending / 无状态：读回仅作参考信息（不得因疑似跳过发送——同内容不同 turn 是真实历史）
      const suspected = await readBack(record);
      if (suspected === true) stats.suspectedResend += 1;

      try {
        await coreClient.addConversation({ sessionId: record.memorySessionId, messages: record.messages });
        await dedupe.markAcknowledged(key, { via: "spool-retry" });
        stats.resent += 1;
        return true;
      } catch (error) {
        const delivery = error?.delivery ?? "maybe_sent";
        if (delivery === "rejected") {
          stats.droppedRejected += 1;
          return true; // 明确拒绝：出队（保留会是死循环）
        }
        if (delivery === "maybe_sent") {
          await dedupe.markUnknown(key, { via: "spool-retry-unknown" });
        }
        return false; // definitely_not_sent / unknown：保留等下次
      }
    },
    { runtimeDir },
  );
  return { processed, budgetExceeded: !hasBudget(), ...stats };
}
