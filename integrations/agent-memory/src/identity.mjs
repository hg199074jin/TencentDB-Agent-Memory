/**
 * identity.mjs — 授权作用域解析（fail-closed）。
 *
 * 契约：
 *   - 身份五元组（serviceId/userId/teamId/agentId/taskId）必须完整显式配置；
 *   - 可选的 authorized allowlist 进一步限定允许的 (teamId, agentId) 组合；
 *   - 任何缺失/不匹配 → { ok: false, reason }，调用方必须放弃 recall 与 capture；
 *   - 永远不提供 "default" 公共作用域兜底。
 */

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {{ config: { serviceId?: string, identity?: Record<string,string|undefined> },
 *           allowed?: Array<{ teamId: string, agentId: string }> }} input
 */
export function createIdentityPolicy({ config, allowed }) {
  return {
    config,
    allowed: Array.isArray(allowed) ? allowed.map((entry) => ({ ...entry })) : null,
  };
}

/**
 * 解析本次调用的记忆作用域。
 * @returns {{ ok: true, identity: object } | { ok: false, reason: string }}
 */
export function resolveScope(policy, { client, sessionId } = {}) {
  const config = policy?.config ?? {};
  const identity = config.identity ?? {};
  const serviceId = typeof config.serviceId === "string" ? config.serviceId.trim() : "";

  if (!nonEmpty(serviceId)) {
    return { ok: false, reason: "identity incomplete: serviceId is required (no anonymous scope)" };
  }
  for (const field of ["userId", "teamId", "agentId"]) {
    if (!nonEmpty(identity[field])) {
      return { ok: false, reason: `identity incomplete: ${field} is required` };
    }
  }
  if (identity.taskId !== undefined && !nonEmpty(identity.taskId)) {
    return { ok: false, reason: "identity incomplete: taskId must be non-empty when present" };
  }

  const resolved = {
    serviceId,
    userId: identity.userId.trim(),
    teamId: identity.teamId.trim(),
    agentId: identity.agentId.trim(),
    taskId: nonEmpty(identity.taskId) ? identity.taskId.trim() : undefined,
    sessionId: nonEmpty(sessionId) ? sessionId.trim() : undefined,
  };

  if (policy.allowed) {
    const authorized = policy.allowed.some(
      (entry) => entry.teamId === resolved.teamId && entry.agentId === resolved.agentId,
    );
    if (!authorized) {
      return {
        ok: false,
        reason: `scope not in authorized allowlist: team=${resolved.teamId} agent=${resolved.agentId} client=${client ?? "unknown"}`,
      };
    }
  }

  return { ok: true, identity: resolved };
}
