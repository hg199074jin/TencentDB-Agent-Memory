function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid metadata client configuration: ${field}`);
  }
  return value.trim();
}

function listItems(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.items)) {
    throw new Error("Invalid Metadata API list response");
  }
  return data.items;
}

export class MetadataClient {
  constructor({ endpoint, apiKey, serviceId, userKey }) {
    this.endpoint = requiredString(endpoint, "endpoint").replace(/\/+$/, "");
    this.apiKey = requiredString(apiKey, "apiKey");
    this.serviceId = requiredString(serviceId, "serviceId");
    this.userKey = requiredString(userKey, "userKey");
  }

  async verifyCurrentUser() {
    const data = await this.#post("/v3/meta/auth/verify", { user_key: this.userKey });
    if (data === null || typeof data !== "object" || Array.isArray(data) || data.valid !== true) {
      throw new Error("Metadata authentication was not accepted");
    }
    return data.user;
  }

  async listTeams({ userId, name }) {
    return listItems(await this.#post("/v3/meta/team/list", { user_id: userId, name, limit: 100 }));
  }

  async createTeam({ name, ownerUserId }) {
    return this.#post("/v3/meta/team/create", { name, owner_user_id: ownerUserId });
  }

  async listAgents({ teamId, name }) {
    return listItems(await this.#post("/v3/meta/agent/list", { team_id: teamId, name, limit: 100 }));
  }

  async createAgent({ teamId, ownerUserId, name }) {
    return this.#post("/v3/meta/agent/create", {
      team_id: teamId,
      owner_user_id: ownerUserId,
      name
    });
  }

  async listTasks({ teamId, title }) {
    return listItems(await this.#post("/v3/meta/task/list", { team_id: teamId, title, limit: 100 }));
  }

  async createTask({ teamId, creatorUserId, title, agentId }) {
    return this.#post("/v3/meta/task/create", {
      team_id: teamId,
      creator_user_id: creatorUserId,
      title,
      linked_agents: [{ agent_id: agentId }]
    });
  }

  async listTaskAgents({ taskId }) {
    return listItems(await this.#post("/v3/meta/task-agent/list", { task_id: taskId, limit: 100 }));
  }

  async getUser(userId) { return this.#post("/v3/meta/user/get", { user_id: userId }); }
  async getTeam(teamId) { return this.#post("/v3/meta/team/get", { team_id: teamId }); }
  async getAgent(agentId) { return this.#post("/v3/meta/agent/get", { agent_id: agentId }); }
  async getTask(taskId) { return this.#post("/v3/meta/task/get", { task_id: taskId }); }

  async listChatMemoryAssets({ teamId }) {
    return listItems(await this.#post("/v3/meta/asset/list", {
      team_id: teamId,
      asset_type: "chat_memory",
      limit: 100
    }));
  }

  async #post(path, body) {
    let response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "x-tdai-service-id": this.serviceId,
          "x-tdai-user-key": this.userKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error("Metadata API unavailable");
    }
    if (!response.ok) throw new Error("Metadata API rejected the request");
    let envelope;
    try {
      envelope = JSON.parse(await response.text());
    } catch {
      throw new Error("Invalid Metadata API response");
    }
    if (
      envelope === null || typeof envelope !== "object" || Array.isArray(envelope) ||
      typeof envelope.code !== "number" || typeof envelope.message !== "string" ||
      typeof envelope.request_id !== "string" || !Object.hasOwn(envelope, "data") || envelope.code !== 0
    ) {
      throw new Error("Invalid Metadata API response");
    }
    return envelope.data;
  }
}
