import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  OFFICIAL_IDENTITY_NAMES,
  bootstrapConfig
} from "../src/bootstrap-config.mjs";

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function withSandbox(run) {
  const root = await mkdtemp(join(tmpdir(), "cross-agent-bootstrap-"));
  try {
    await run({
      adapterRoot: join(root, "integrations", "cross-agent-memory"),
      deployDir: join(root, "deploy", "global-images")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class MetadataFixture {
  constructor({ user = { user_id: "usr-owner", status: "active" } } = {}) {
    this.user = user;
    this.teams = [];
    this.agents = [];
    this.tasks = [];
    this.links = [];
    this.assets = [];
    this.next = 1;
  }

  async verifyCurrentUser() { return this.user; }
  async listTeams({ name }) { return this.teams.filter((item) => item.name === name); }
  async createTeam({ name, ownerUserId }) {
    const team = { team_id: `team-${this.next++}`, name, owner_user_id: ownerUserId, status: "active" };
    this.teams.push(team);
    return team;
  }
  async listAgents({ teamId, name }) {
    return this.agents.filter((item) => item.team_id === teamId && item.name === name);
  }
  async createAgent({ teamId, ownerUserId, name }) {
    const agent = { agent_id: `agt-${this.next++}`, team_id: teamId, owner_user_id: ownerUserId, name, status: "active" };
    this.agents.push(agent);
    return agent;
  }
  async listTasks({ teamId, title }) {
    return this.tasks.filter((item) => item.team_id === teamId && item.title === title);
  }
  async createTask({ teamId, creatorUserId, title, agentId }) {
    const task = { task_id: `task-${this.next++}`, team_id: teamId, creator_user_id: creatorUserId, title, status: "active" };
    this.tasks.push(task);
    this.links.push({ task_id: task.task_id, agent_id: agentId });
    return task;
  }
  async listTaskAgents({ taskId }) { return this.links.filter((item) => item.task_id === taskId); }
}

async function setupDeployment(deployDir) {
  await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=gateway-test-token\n");
  await writeText(join(deployDir, ".admin-key"), "admin-user-key-only-for-metadata\n");
}

function gatewayFactory(config) {
  return { readCore: async () => ({ acceptedIdentity: config.identity }) };
}

test("bootstrap creates the official metadata graph and writes only generated IDs", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();

    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory });
    const config = JSON.parse(await readFile(join(adapterRoot, "config.local.json"), "utf8"));

    assert.equal(result.status, "CREATED");
    assert.deepEqual(config.identity, {
      userId: "usr-owner",
      teamId: "team-1",
      agentId: "agt-2",
      taskId: "task-3"
    });
    assert.equal(config.apiKey, "gateway-test-token");
    assert.equal(JSON.stringify(config).includes("admin-user-key-only-for-metadata"), false);
    assert.equal(metadata.teams[0].name, OFFICIAL_IDENTITY_NAMES.team);
    assert.equal(metadata.agents[0].name, OFFICIAL_IDENTITY_NAMES.agent);
    assert.equal(metadata.tasks[0].title, OFFICIAL_IDENTITY_NAMES.task);
    assert.deepEqual(metadata.links, [{ task_id: "task-3", agent_id: "agt-2" }]);
  });
});

test("bootstrap reuses one exact graph and completes a retry after partial creation", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const metadata = new MetadataFixture();
    const team = await metadata.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });
    const agent = await metadata.createAgent({ teamId: team.team_id, ownerUserId: "usr-owner", name: OFFICIAL_IDENTITY_NAMES.agent });
    let firstTaskCreate = true;
    const createTask = metadata.createTask.bind(metadata);
    metadata.createTask = async (input) => {
      if (firstTaskCreate) {
        firstTaskCreate = false;
        throw new Error("interrupted before task creation");
      }
      return createTask(input);
    };

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory }),
      /metadata/i
    );
    await assert.rejects(readFile(join(adapterRoot, "config.local.json"), "utf8"), { code: "ENOENT" });

    const result = await bootstrapConfig({ adapterRoot, deployDir, metadataClient: metadata, gatewayFactory });
    assert.equal(result.status, "CREATED");
    assert.equal(metadata.teams.length, 1);
    assert.equal(metadata.agents.length, 1);
    assert.equal(metadata.tasks.length, 1);
    assert.deepEqual(result.identity, { userId: "usr-owner", teamId: team.team_id, agentId: agent.agent_id, taskId: "task-3" });
  });
});

test("bootstrap stops on exact-name conflicts, malformed metadata, or invalid relationships without replacing config", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await setupDeployment(deployDir);
    const original = Buffer.from('{"keep":"original"}\r\n', "utf8");
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    const conflict = new MetadataFixture();
    await conflict.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });
    await conflict.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-owner" });

    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: conflict, gatewayFactory }),
      /conflict|metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const malformed = new MetadataFixture();
    malformed.verifyCurrentUser = async () => ({ user_id: "usr-owner" });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: malformed, gatewayFactory }),
      /metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const denied = new MetadataFixture();
    denied.listTeams = async () => { throw new Error("permission denied"); };
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: denied, gatewayFactory }),
      /metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);

    const mismatch = new MetadataFixture();
    const wrongTeam = await mismatch.createTeam({ name: OFFICIAL_IDENTITY_NAMES.team, ownerUserId: "usr-other" });
    await mismatch.createAgent({ teamId: wrongTeam.team_id, ownerUserId: "usr-owner", name: OFFICIAL_IDENTITY_NAMES.agent });
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, force: true, metadataClient: mismatch, gatewayFactory }),
      /relationship|metadata/i
    );
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);
  });
});

test("bootstrap requires an admin key and preserves original bytes if replacement fails", async () => {
  await withSandbox(async ({ adapterRoot, deployDir }) => {
    await writeText(join(deployDir, ".env"), "MEMORY_CORE_GATEWAY_API_KEY=gateway-test-token\n");
    await assert.rejects(
      bootstrapConfig({ adapterRoot, deployDir, metadataClient: new MetadataFixture(), gatewayFactory }),
      /admin.*key/i
    );

    await setupDeployment(deployDir);
    const original = Buffer.from('{"legacy":true}\r\n', "utf8");
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(join(adapterRoot, "config.local.json"), original);
    const result = bootstrapConfig({
      adapterRoot,
      deployDir,
      force: true,
      metadataClient: new MetadataFixture(),
      gatewayFactory,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      renameFile: async () => { throw new Error("replace failure"); }
    });
    await assert.rejects(result, /replace/i);
    assert.deepEqual(await readFile(join(adapterRoot, "config.local.json")), original);
    const backupPath = join(adapterRoot, "runtime", "backups", `bootstrap-2026-08-10T00-00-00.000Z-${process.pid}`, "config.local.json");
    assert.deepEqual(await readFile(backupPath), original);
  });
});
