function withoutUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function requestError(detail) {
  return new Error(`Memory gateway request failed: ${detail}`);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid gateway config: ${field} is required`);
  }
  return value.trim();
}

export class GatewayClient {
  constructor(config) {
    const identity = config?.identity ?? {};
    this.config = {
      ...config,
      endpoint: requiredString(config?.endpoint, "endpoint"),
      apiKey: requiredString(config?.apiKey, "apiKey"),
      serviceId: requiredString(config?.serviceId, "serviceId"),
      identity: {
        teamId: requiredString(identity.teamId, "teamId"),
        agentId: requiredString(identity.agentId, "agentId"),
        userId: requiredString(identity.userId, "userId"),
        taskId: requiredString(identity.taskId, "taskId")
      }
    };
  }

  async searchConversation(query, limit) {
    return this.#post("/v3/conversation/search", { query, limit }, this.config.timeouts.recallMs);
  }

  async queryConversation(sessionId, limit = 20) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw requestError("missing query session");
    }
    return this.#post(
      "/v3/conversation/query",
      { session_id: sessionId, limit },
      this.config.timeouts.recallMs
    );
  }

  async searchAtomic(query, limit) {
    return this.#post("/v3/atomic/search", { query, limit }, this.config.timeouts.recallMs);
  }

  async readCore() {
    return this.#post("/v3/core/read", {}, this.config.timeouts.recallMs);
  }

  async addConversation(sessionId, messages) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw requestError("missing write session");
    }
    return this.#post(
      "/v3/conversation/add",
      { session_id: sessionId, messages },
      this.config.timeouts.captureMs
    );
  }

  async #post(path, request, timeoutMs) {
    const { identity } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(`${this.config.endpoint}${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "x-tdai-service-id": this.config.serviceId,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(withoutUndefined({
            team_id: identity.teamId,
            agent_id: identity.agentId,
            user_id: identity.userId,
            task_id: identity.taskId,
            ...request
          }))
        });
      } catch (error) {
        if (error?.name === "AbortError") throw requestError("timeout");
        throw requestError("transport error");
      }

      if (!response.ok) throw requestError(`HTTP ${response.status}`);

      let envelope;
      try {
        envelope = JSON.parse(await response.text());
      } catch {
        throw requestError("invalid JSON response");
      }
      if (
        !envelope
        || typeof envelope !== "object"
        || Array.isArray(envelope)
        || typeof envelope.code !== "number"
        || typeof envelope.message !== "string"
        || typeof envelope.request_id !== "string"
        || !Object.hasOwn(envelope, "data")
      ) {
        throw requestError("invalid response envelope");
      }
      if (envelope.code !== 0) {
        const requestId = typeof envelope.request_id === "string" ? ` request ${envelope.request_id}` : "";
        throw requestError(`code ${envelope.code}${requestId}`);
      }
      return envelope.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
