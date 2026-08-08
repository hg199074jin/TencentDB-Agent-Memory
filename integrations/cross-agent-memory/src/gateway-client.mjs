function withoutUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function requestError(detail) {
  return new Error(`Memory gateway request failed: ${detail}`);
}

export class GatewayClient {
  constructor(config) {
    this.config = config;
  }

  async searchConversation(query, limit) {
    return this.#post("/v3/conversation/search", { query, limit }, this.config.timeouts.recallMs);
  }

  async queryConversation(sessionId, limit = 20) {
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
      if (!envelope || typeof envelope !== "object" || typeof envelope.code !== "number") {
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
