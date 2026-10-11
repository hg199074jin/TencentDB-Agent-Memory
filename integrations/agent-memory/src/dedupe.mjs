/**
 * dedupe.mjs — 单轮幂等状态机（M2）。
 *
 * turnKey = SHA256(serviceId, teamId, userId, agentId, client, sessionId, turnId)
 *   —— 含全部身份维度与回合 ID；不用 hash(userText)（用户重问同一句不应被误去重）。
 *
 * 状态机：pending → sending → acknowledged | unknown
 *   - acknowledged：写入被 ACK，或读回校验发现服务端已有同内容轮次
 *   - unknown：请求已发出但响应未知（超时/断连）——不自动重试（可能已写入），
 *     仅允许显式 reconcile()（读回对账）转 acknowledged
 *   - pending：发送前失败（连接拒绝等）——可安全重试
 *
 * 持久化：stateDir/turns.json（原子替换）。进程重启后 acknowledged/unknown 仍然有效。
 * 已知限制（服务端）：Core v3 /v3/conversation/add 无 idempotency_key 参数，
 * exactly-once 依仗"本地持久化 + 写前读回 + unknown 不盲目重试"三重机制；
 * 服务端幂等键提案见 docs/agent-memory/ARCHITECTURE.md（未改生产 schema）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export function turnKey({ serviceId, teamId, userId, agentId, client, sessionId, turnId }) {
  const parts = [serviceId, teamId, userId, agentId, client, sessionId, turnId];
  if (parts.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`turnKey requires all identity dimensions: ${parts.map((p) => String(p)).join("/")}`);
  }
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** 会话 → Core L0 session 命名空间（与生产 hook-cli makeMemorySessionId 一致）。 */
export function memorySessionIdFor(client, sourceSessionId) {
  return `${client}-${createHash("sha256").update(String(sourceSessionId)).digest("hex").slice(0, 24)}`;
}

export class TurnDedupe {
  constructor({ stateDir, memory, maxTracked = 5000 } = {}) {
    this.stateDir = stateDir;
    this.memory = memory instanceof Map ? memory : new Map();
    this.maxTracked = maxTracked;
    this.loaded = false;
    if (stateDir) {
      // 同步加载：stateOf() 是同步 API，插件/CLI 启动路径可接受一次性小文件读
      try {
        const parsed = JSON.parse(readFileSync(join(stateDir, "turns.json"), "utf8"));
        for (const [key, entry] of Object.entries(parsed ?? {})) {
          if (entry && typeof entry.state === "string") this.memory.set(key, entry);
        }
      } catch {
        /* 首次运行或损坏：从空开始 */
      }
      this.loaded = true;
    }
  }

  stateOf(key) {
    return this.memory.get(key)?.state;
  }

  async #persist() {
    if (!this.stateDir) return;
    try {
      await mkdir(this.stateDir, { recursive: true });
      const entries = [...this.memory.entries()].slice(-this.maxTracked);
      const payload = Object.fromEntries(entries);
      const tmp = join(this.stateDir, `turns.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, join(this.stateDir, "turns.json"));
    } catch {
      /* 持久化失败不阻断主流程；内存态仍是当次进程的去重来源 */
    }
  }

  async #set(key, state, extra = {}) {
    this.memory.set(key, { state, attempts: (this.memory.get(key)?.attempts ?? 0) + 1, updatedAt: new Date().toISOString(), ...extra });
    await this.#persist();
  }

  /** 外部确认已写入（如 spool 重试成功、运维对账）时调用。 */
  async markAcknowledged(key, extra = {}) {
    const state = this.stateOf(key);
    if (state === "acknowledged") return;
    await this.#set(key, "acknowledged", extra);
  }

  /** 从磁盘重读状态（拿锁后调用，确保看到其他进程的最新写入）。 */
  async #reloadFromDisk() {
    if (!this.stateDir) return;
    try {
      const parsed = JSON.parse(await readFile(join(this.stateDir, "turns.json"), "utf8"));
      for (const [key, entry] of Object.entries(parsed ?? {})) {
        if (entry && typeof entry.state === "string") this.memory.set(key, entry);
      }
    } catch {
      /* 文件不存在/损坏：保留当前内存态 */
    }
  }

  // ── 跨进程锁：并发 Hook/Plugin 进程对同一 turn 串行化 ─────────────────────
  // mkdir 原子创建作为互斥； stale lock（持锁进程崩溃）超龄后 Breaking。

  async #acquireLock(key, timeoutMs) {
    if (!this.stateDir) return null; // 纯内存模式（单进程测试）无锁
    const lockDir = join(this.stateDir, "locks");
    const lockPath = join(lockDir, `${key}.lock`);
    const deadline = Date.now() + timeoutMs;
    await mkdir(lockDir, { recursive: true });
    for (;;) {
      try {
        await mkdir(lockPath, { recursive: false });
        // 拿锁后重读持久化状态：其他进程可能在锁外写过（内存 Map 已过期）
        await this.#reloadFromDisk();
        return lockPath;
      } catch (error) {
        if (error?.code !== "EEXIST") return null; // 锁不可用不阻断主流程
        // stale lock：超过 10s 视为崩溃残留，破锁
        try {
          const stat = await import("node:fs/promises").then((fs) => fs.stat(lockPath));
          if (Date.now() - stat.mtimeMs > 10_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // 锁已被释放，重试
        }
        if (Date.now() >= deadline) return null; // 拿不到锁：放行（读回校验仍是兜底）
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  async #releaseLock(lockPath) {
    if (!lockPath) return;
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * 执行一次带幂等保护的写入。
   * @returns {Promise<{status:'acknowledged'|'duplicate'|'retryable'|'unknown', via?:string, error?:string}>}
   */
  async execute({ key, sessionId, messages, send, verify }) {
    const state = this.stateOf(key);
    if (state === "acknowledged") return { status: "duplicate" };
    if (state === "unknown") return { status: "unknown", reason: "previous attempt has unknown ack; reconcile required" };

    // 跨进程串行化：锁内完成 状态检查→读回→发送→持久化
    const lockPath = await this.#acquireLock(key, 1500);
    try {
      const lockedState = this.stateOf(key);
      if (lockedState === "acknowledged") return { status: "duplicate" };
      if (lockedState === "unknown") return { status: "unknown", reason: "previous attempt has unknown ack; reconcile required" };

      // 写前读回校验（服务端已有同内容 → 视同已写入）
      if (typeof verify === "function") {
        try {
          if (await verify({ key, sessionId, messages })) {
            await this.#set(key, "acknowledged", { via: "read-back" });
            return { status: "acknowledged", via: "read-back" };
          }
        } catch {
          /* 校验失败不阻断：继续走发送路径 */
        }
      }

      await this.#set(key, "sending");
      try {
        const receipt = await send({ key, sessionId, messages });
        await this.#set(key, "acknowledged", { via: "ack" });
        return { status: "acknowledged", via: "ack", receipt };
      } catch (error) {
        const afterSend = error?.afterSend === true;
        await this.#set(key, afterSend ? "unknown" : "pending");
        return afterSend
          ? { status: "unknown", reason: "request may have reached the server; not retried", error: String(error?.message ?? error) }
          : { status: "retryable", error: String(error?.message ?? error) };
      }
    } finally {
      await this.#releaseLock(lockPath);
    }
  }

  /** 对账：读回确认 unknown 的写入是否实际到达。 */
  async reconcile({ key, verify }) {
    if (this.stateOf(key) !== "unknown") {
      return { status: this.stateOf(key) === "acknowledged" ? "acknowledged" : "skipped" };
    }
    try {
      if (await verify({ key })) {
        await this.#set(key, "acknowledged", { via: "reconcile" });
        return { status: "acknowledged", via: "reconcile" };
      }
    } catch {
      /* 对账失败保持 unknown */
    }
    return { status: "unknown" };
  }
}
