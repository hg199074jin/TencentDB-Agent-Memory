/**
 * core-client.mjs — TencentDB Agent Memory Core v3 客户端。
 *
 * 契约对齐官方 SDK `@tencentdb-agent-memory/memory-sdk-ts-v2`（v3）：
 *   - 隔离上下文 V3IsolationContext{ team_id, agent_id, user_id, session_id?, task_id? }
 *   - 方法名与 SDK 一致；listScenarios({ path_prefix })、readScenario({ path })
 *     与官方 client.ts 逐字段一致（R2 修复：旧版误用 session_id/scenario 字段）
 *   - /v3/conversation/add 单条消息 content 1–8192 字符（官方 v3-api 文档），
 *     按码点计数；超限在客户端即拒绝（delivery='rejected'），不进入服务端调用
 *
 * R2 关键修复（P0-A）：所有失败以**判别联合 delivery** 表达写入送达状态：
 *   - 'definitely_not_sent'  请求未离开客户端（连接拒绝/DNS/发送前取消）→ 可安全重试
 *   - 'maybe_sent'           请求已发出但结果未知（超时/断连/部分响应/5xx/408/429）
 *                           → 调用方必须按 unknown 对账，禁止自动重试
 *   - 'rejected'             服务端明确拒绝（4xx/envelope 业务错误/客户端校验失败）
 *                           → 不重试；禁止退化身份重发
 * 无 server-side idempotency 时不宣称全局 exactly-once；调用方最佳努力幂等。
 */

export class CoreDeliveryError extends Error {
  constructor(message, { delivery, status, code, requestId, cause } = {}) {
    super(message);
    this.name = "CoreDeliveryError";
    this.delivery = delivery;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.cause = cause;
  }
}

/** 兼容旧名：传输类错误的基类（delivery 形参可缺省，调用方应读 delivery 字段）。 */
export class CoreTransportError extends CoreDeliveryError {}

/** 服务端业务/协议拒绝（HTTP 4xx、envelope code!=0、客户端校验失败）。 */
export class CoreApiError extends CoreDeliveryError {
  constructor(message, options = {}) {
    super(message, { delivery: "rejected", ...options });
    this.name = "CoreApiError";
  }
}

/** v3 官方限制：单条消息 1–8192 字符（码点）。 */
export const MAX_MESSAGE_CODE_POINTS = 8192;
export const MAX_MESSAGES_PER_TURN = 100;

function codePointLength(value) {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/** 客户端侧消息校验：拒绝超限/空消息/过多消息（delivery='rejected'，不进网络）。 */
export function validateConversationMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CoreApiError("conversation/add requires at least one message", { code: "invalid_request" });
  }
  if (messages.length > MAX_MESSAGES_PER_TURN) {
    throw new CoreApiError(`conversation/add accepts at most ${MAX_MESSAGES_PER_TURN} messages`, { code: "invalid_request" });
  }
  for (const [index, message] of messages.entries()) {
    const content = message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new CoreApiError(`conversation/add message[${index}].content must be a non-empty string`, { code: "invalid_request" });
    }
    const points = codePointLength(content);
    if (points > MAX_MESSAGE_CODE_POINTS) {
      throw new CoreApiError(
        `conversation/add message[${index}] content is ${points} code points (> ${MAX_MESSAGE_CODE_POINTS})`,
        { code: "invalid_request" },
      );
    }
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid core client config: ${field} is required`);
  }
  return value.trim();
}

/**
 * 连接层错误码：请求**确定未离开客户端**才可安全重试。
 * 仅限连接建立前的失败（拒绝/DNS/路由）；ECONNABORTED/ECONNRESET 等可能发生在
 * 发送中或发送后，一律保守按 maybe_sent（R3 修复：旧集合误含 ECONNABORTED）。
 */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

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

  async listScenarios({ pathPrefix } = {}, { signal } = {}) {
    // 官方契约：path_prefix（R2 修复：旧版误发 session_id）
    return this.#post("/v3/scenario/ls", withoutUndefined({ path_prefix: pathPrefix }), signal);
  }

  async readScenario({ path, name }, { signal } = {}) {
    // 官方契约：path（name 为兼容别名）
    return this.#post("/v3/scenario/read", withoutUndefined({ path: path ?? name }), signal);
  }

  async readCore(_params = {}, { signal } = {}) {
    return this.#post("/v3/core/read", {}, signal);
  }

  // ── v3 写接口 ────────────────────────────────────────────────────────────

  async addConversation({ sessionId, messages }, { signal } = {}) {
    validateConversationMessages(messages); // 客户端前置校验，避免服务端永久拒绝→spool 死循环
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

    let requestStarted = false;
    try {
      let response;
      try {
        requestStarted = true;
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
        const notSentCode = !aborted && NOT_SENT_CODES.has(error?.cause?.code);
        // 未开始发送 / 连接层失败 → definitely_not_sent；其余（含发送后超时）→ maybe_sent
        const delivery = !requestStarted || notSentCode ? "definitely_not_sent" : "maybe_sent";
        const message = aborted
          ? `core request ${requestStarted ? "timed out" : "aborted before send"} after ${this.timeoutMs}ms: ${path}`
          : `core transport error (${delivery}): ${path}: ${error?.message ?? error}`;
        throw new CoreTransportError(message, { delivery, cause: error });
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch (error) {
        // 响应头已到达：服务端已受理请求，结果未知
        throw new CoreTransportError(`core partial/invalid response body: ${path} HTTP ${response.status}`, {
          delivery: "maybe_sent",
          status: response.status,
          cause: error,
        });
      }
      if (!response.ok) {
        // 授权/校验类 4xx → 明确拒绝；408/429/5xx → 无法证明未落库，保守按 maybe_sent
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CoreTransportError(`core HTTP ${response.status}: ${path}`, {
          delivery: retryableStatus ? "maybe_sent" : "rejected",
          status: response.status,
          requestId: envelope?.request_id,
        });
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
