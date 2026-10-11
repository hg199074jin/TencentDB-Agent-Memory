/**
 * core-client.mjs — TencentDB Agent Memory Core v3 客户端。
 *
 * 契约对齐官方 SDK `@tencentdb-agent-memory/memory-sdk-ts-v2`（v3）：
 *   - 隔离上下文 V3IsolationContext{ team_id, agent_id, user_id, session_id?, task_id? }
 *   - 方法名与 SDK 一致：addConversation / queryConversation / searchConversation /
 *     searchAtomic / queryAtomic / listScenarios / readScenario / readCore
 *   - 服务级 Bearer（Authorization）+ x-tdai-service-id 头
 *   - 统一 envelope { code, message, request_id, data } 校验；code!=0 抛错
 *   - 每次调用可配超时（AbortController），传输失败归类 CoreTransportError
 *
 * 本客户端不平行重造 SDK：端点/envelope/字段与官方 v3 一致，便于随时替换为官方 SDK
 * （方法同名、隔离字段同名，属 drop-in）。
 */

export class CoreTransportError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "CoreTransportError";
    this.cause = cause;
  }
}

export class CoreApiError extends Error {
  constructor(message, { code, requestId } = {}) {
    super(message);
    this.name = "CoreApiError";
    this.code = code;
    this.requestId = requestId;
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid core client config: ${field} is required`);
  }
  return value.trim();
}

export class CoreClient {
  constructor({
    endpoint,
    apiKey,
    serviceId,
    isolation,
    timeoutMs = 3000,
    fetchImpl = globalThis.fetch.bind(globalThis),
  }) {
    this.endpoint = requiredString(endpoint, "endpoint").replace(/\/+$/, "");
    this.apiKey = requiredString(apiKey, "apiKey");
    this.serviceId = requiredString(serviceId, "serviceId");
    this.isolation = { ...isolation };
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** 返回带隔离覆盖的新客户端（不修改原实例）。 */
  withIsolation(overrides = {}) {
    const merged = { ...this.isolation };
    if (overrides.teamId !== undefined) merged.team_id = overrides.teamId;
    if (overrides.agentId !== undefined) merged.agent_id = overrides.agentId;
    if (overrides.userId !== undefined) merged.user_id = overrides.userId;
    if (overrides.taskId !== undefined) merged.task_id = overrides.taskId;
    if (overrides.sessionId !== undefined) merged.session_id = overrides.sessionId;
    return new CoreClient({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      serviceId: this.serviceId,
      isolation: merged,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  // ── v3 读接口 ────────────────────────────────────────────────────────────

  async searchConversation({ query, limit = 5, sessionId, time_start, time_end }, { signal } = {}) {
    return this.#post("/v3/conversation/search", withoutUndefined({ query, limit, session_id: sessionId, time_start, time_end }), signal);
  }

  async queryConversation({ sessionId, limit = 20, offset = 0, time_start, time_end } = {}, { signal } = {}) {
    return this.#post(
      "/v3/conversation/query",
      withoutUndefined({ session_id: sessionId, limit, offset, time_start, time_end }),
      signal,
    );
  }

  async searchAtomic({ query, limit = 5, sessionId, time_start, time_end }, { signal } = {}) {
    return this.#post("/v3/atomic/search", withoutUndefined({ query, limit, session_id: sessionId, time_start, time_end }), signal);
  }

  async queryAtomic({ limit = 20, offset = 0, sessionId } = {}, { signal } = {}) {
    return this.#post("/v3/atomic/query", withoutUndefined({ limit, offset, session_id: sessionId }), signal);
  }

  async listScenarios({ sessionId } = {}, { signal } = {}) {
    return this.#post("/v3/scenario/ls", withoutUndefined({ session_id: sessionId }), signal);
  }

  async readScenario({ name }, { signal } = {}) {
    return this.#post("/v3/scenario/read", withoutUndefined({ scenario: name }), signal);
  }

  async readCore(_params = {}, { signal } = {}) {
    return this.#post("/v3/core/read", {}, signal);
  }

  // ── v3 写接口 ────────────────────────────────────────────────────────────

  async addConversation({ sessionId, messages }, { signal } = {}) {
    return this.#post(
      "/v3/conversation/add",
      withoutUndefined({ session_id: sessionId, messages }),
      signal,
    );
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  async #post(path, body, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cancel = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener("abort", cancel, { once: true });

    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.endpoint}${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "x-tdai-service-id": this.serviceId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...this.isolation, ...body }),
        });
      } catch (error) {
        const aborted = error?.name === "AbortError" || controller.signal.aborted;
        throw new CoreTransportError(aborted ? `core request timeout after ${this.timeoutMs}ms: ${path}` : `core transport error: ${path}: ${error?.message ?? error}`, { cause: error });
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch (error) {
        throw new CoreTransportError(`core invalid JSON: ${path} HTTP ${response.status}`, { cause: error });
      }
      if (!response.ok) {
        throw new CoreApiError(`core HTTP ${response.status}: ${path}`, { code: response.status, requestId: envelope?.request_id });
      }
      if (!envelope || typeof envelope !== "object" || typeof envelope.code !== "number") {
        throw new CoreApiError(`core invalid envelope: ${path}`, { code: -1, requestId: envelope?.request_id });
      }
      if (envelope.code !== 0) {
        throw new CoreApiError(`core envelope error ${envelope.code}: ${envelope.message ?? ""}`, {
          code: envelope.code,
          requestId: envelope.request_id,
        });
      }
      return envelope.data;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }
}

function withoutUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
