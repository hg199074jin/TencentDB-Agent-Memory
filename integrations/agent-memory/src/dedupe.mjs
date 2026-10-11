/**
 * dedupe.mjs — 单轮幂等状态机（GPT-AM-001-R2 收口）。
 *
 * turnKey = SHA256(serviceId, teamId, userId, agentId, client, sessionId, turnId)
 *
 * 状态机：
 *   pending --send--> sending --ACK--> acknowledged
 *      |                  |
 *      |          崩溃/超时/断连（delivery=maybe_sent）
 *      v                  v
 *   retryable          unknown ──reconcile(读回)──► acknowledged(suspected) | 保持 unknown
 *
 * 硬规则（R2）：
 *   - 拿不到跨进程锁 → deferred：**绝不发送**（禁止拿不到锁就碰运气）；
 *   - 持久化失败 → degraded：后续 execute 一律 deferred，直到持久化恢复；
 *   - 持久化的 'sending'（进程崩溃残留）+ 已持锁 → unknown：禁止无条件重发；
 *   - 锁带 owner token（pid+uuid+heartbeat）：仅持有者可释放；stale 回收需确认
 *     持锁进程已死亡（或心跳超龄 30s），不允许活锁复用；
 *   - 状态文件 merge-on-write + 跨进程写锁：不同 key 并发更新不相互覆盖；
 *   - 无 server-side idempotency：本模块是客户端最佳努力幂等，不宣称全局
 *     exactly-once。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, stat, open } from "node:fs/promises";
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

const LOCK_STALE_DEAD_MS = 10_000;   // 持锁进程已死亡判定的最短心跳年龄
const LOCK_STALE_HUNG_MS = 30_000;   // 持锁进程存活但心跳超龄（挂死）的回收阈值
const LOCK_OWNER_GRACE_MS = 1_000;   // 持锁方 mkdir→写 owner.json 的窗口宽限期
const WRITE_LOCK_WAIT_MS = 2_000;
/** 内存模式哨兵：#acquireLock 在无 stateDir 时返回它，表示"无需持锁"。 */
const MEMORY_MODE = "memory-mode";

const TERMINAL_RANK = { acknowledged: 3, denied: 2, unknown: 1 };
const isTerminal = (state) => Object.prototype.hasOwnProperty.call(TERMINAL_RANK, state);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // 存在但无权信号 → 仍算存活
  }
}

export class TurnDedupe {
  constructor({ stateDir, memory, maxTracked = 5000 } = {}) {
    this.stateDir = stateDir;
    this.memory = memory instanceof Map ? memory : new Map();
    this.maxTracked = maxTracked;
    this.degraded = false; // 持久化失败后置位；恢复成功清除
    this.corrupted = false; // 状态文件损坏（非 ENOENT）：fail-closed，禁止发送
    this.dirtyKeys = new Set(); // 本进程自上次持久化以来修改过的 key（merge-on-write 只写这些）
    this.token = createHash("sha256").update(`${process.pid}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12);
    if (stateDir) {
      try {
        const parsed = JSON.parse(readFileSync(join(stateDir, "turns.json"), "utf8"));
        for (const [key, entry] of Object.entries(parsed ?? {})) {
          if (entry && typeof entry.state === "string") this.memory.set(key, entry);
        }
      } catch (error) {
        // ENOENT = 首次运行（正常）；其余（解析失败/权限）→ 损坏，fail-closed
        if (error?.code !== "ENOENT") {
          this.corrupted = true;
          this.degraded = true;
        }
      }
    }
  }

  stateOf(key) {
    return this.memory.get(key)?.state;
  }

  isDegraded() {
    return this.degraded === true;
  }

  // ── 持久化：merge-on-write + 跨进程写锁 ─────────────────────────────────

  async #acquireWriteLock() {
    if (!this.stateDir) return null;
    const lockPath = join(this.stateDir, "turns.write.lock");
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lockPath, { recursive: false });
        return lockPath;
      } catch (error) {
        if (error?.code !== "EEXIST") return null;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_HUNG_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  async #releaseWriteLock(lockPath) {
    if (lockPath) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }

  async #persist() {
    if (!this.stateDir) return true;
    const lockPath = await this.#acquireWriteLock();
    if (!lockPath) {
      this.degraded = true; // 拿不到写锁：无法保证持久化
      return false;
    }
    try {
      await mkdir(this.stateDir, { recursive: true });
      // 读入磁盘最新状态；损坏（非 ENOENT）→ fail-closed
      let onDisk = {};
      try {
        onDisk = JSON.parse(await readFile(join(this.stateDir, "turns.json"), "utf8")) ?? {};
      } catch (error) {
        if (error?.code !== "ENOENT") {
          this.corrupted = true;
          this.degraded = true;
          return false;
        }
      }
      // merge-on-write（R3 修复）：只合并**本进程修改过的 key**，
      // 且终态（acknowledged/denied/unknown）永不被非终态覆盖；
      // 同时用磁盘较新的终态刷新本进程内存，避免旧内存日后回写。
      const merged = { ...onDisk };
      for (const key of this.dirtyKeys) {
        const ours = this.memory.get(key);
        if (!ours) continue;
        const disk = onDisk[key];
        if (disk && isTerminal(disk.state)) {
          if (!isTerminal(ours.state)) continue; // 终态不被回退
          if (TERMINAL_RANK[disk.state] > TERMINAL_RANK[ours.state]) continue; // 更强终态优先
        }
        merged[key] = ours;
      }
      for (const [key, entry] of Object.entries(onDisk)) {
        if (this.dirtyKeys.has(key)) continue;
        const current = this.memory.get(key);
        if (!current || (isTerminal(entry.state) && !isTerminal(current.state))) {
          this.memory.set(key, entry); // 吸收他进程的更新，防止本进程旧值随后回写
        }
      }
      const kept = Object.entries(merged)
        .sort(([, a], [, b]) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")))
        .slice(-this.maxTracked);
      const payload = Object.fromEntries(kept);
      const tmp = join(this.stateDir, `turns.${process.pid}.${this.token}.tmp`);
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, join(this.stateDir, "turns.json"));
      this.degraded = false;
      this.dirtyKeys.clear();
      return true;
    } catch {
      this.degraded = true;
      return false;
    } finally {
      await this.#releaseWriteLock(lockPath);
    }
  }

  async #set(key, state, extra = {}) {
    this.dirtyKeys.add(key);
    this.memory.set(key, {
      state,
      attempts: (this.memory.get(key)?.attempts ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    return this.#persist();
  }

  // ── 跨进程回合锁：owner token + 心跳 + 安全 stale 回收 ───────────────────

  async #acquireLock(key, timeoutMs) {
    if (!this.stateDir) return MEMORY_MODE; // 无持久化目录：单进程内存模式，无需互斥
    const lockDir = join(this.stateDir, "locks");
    const lockPath = join(lockDir, `${key}.lock`);
    const deadline = Date.now() + timeoutMs;
    await mkdir(lockDir, { recursive: true });
    const firstSeen = new Map(); // lockPath → 首次见到的时间（owner 宽限期基准）
    for (;;) {
      try {
        await mkdir(lockPath, { recursive: false });
        await this.#writeOwner(lockPath);
        await this.#reloadFromDisk();
        return lockPath;
      } catch (error) {
        if (error?.code !== "EEXIST") return null; // IO/权限错误：不绕过互斥
        let owner = null;
        try {
          owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
        } catch {
          owner = null;
        }
        if (!owner) {
          // 持锁方可能刚 mkdir 尚未写 owner.json：给宽限期，禁止立即抢锁
          const seenAt = firstSeen.get(lockPath) ?? Date.now();
          firstSeen.set(lockPath, seenAt);
          if (Date.now() - seenAt < LOCK_OWNER_GRACE_MS) {
            if (Date.now() >= deadline) return null;
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          // 宽限期后仍无 owner：按目录 mtime 判定 stale
          try {
            const info = await stat(lockPath);
            if (Date.now() - info.mtimeMs <= LOCK_STALE_HUNG_MS) {
              if (Date.now() >= deadline) return null;
              await new Promise((r) => setTimeout(r, 25));
              continue;
            }
          } catch {
            continue; // 锁已消失：重试
          }
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        firstSeen.delete(lockPath);
        const age = Date.now() - owner.heartbeatAt;
        const alive = pidAlive(owner.pid);
        // stale 回收：持锁进程已死且心跳超龄，或挂死超 LOCK_STALE_HUNG_MS
        if ((!alive && age > LOCK_STALE_DEAD_MS) || age > LOCK_STALE_HUNG_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  async #writeOwner(lockPath) {
    await mkdir(lockPath, { recursive: true });
    const ownerFile = join(lockPath, "owner.json");
    const handle = await open(ownerFile, "w");
    await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token, heartbeatAt: Date.now() }));
    await handle.close();
  }

  async #releaseLock(lockPath) {
    if (!lockPath || lockPath === MEMORY_MODE) return;
    try {
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      if (owner?.token !== this.token) return; // 非持有者不得释放
    } catch {
      // owner 信息丢失：保守不释放（等待 stale 回收）
      return;
    }
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }

  async #reloadFromDisk() {
    if (!this.stateDir) return;
    try {
      const parsed = JSON.parse(await readFile(join(this.stateDir, "turns.json"), "utf8"));
      for (const [key, entry] of Object.entries(parsed ?? {})) {
        if (entry && typeof entry.state === "string") this.memory.set(key, entry);
      }
    } catch {
      /* 保留当前内存态 */
    }
  }

  // ── 对外 API ─────────────────────────────────────────────────────────────

  /** 外部确认已写入（spool 重试成功、运维对账）时调用。 */
  async markAcknowledged(key, extra = {}) {
    if (this.stateOf(key) === "acknowledged") return;
    await this.#set(key, "acknowledged", extra);
  }

  /** 外部标记写入结果未知（如 spool 重发后 maybe_sent）。 */
  async markUnknown(key, extra = {}) {
    if (this.stateOf(key) === "unknown") return;
    await this.#set(key, "unknown", extra);
  }

  /**
   * 执行一次带幂等保护的写入。
   * 状态 → 返回：
   *   acknowledged → { status:'acknowledged' }
   *   acknowledged（再次） → { status:'duplicate' }
   *   unknown（含 sending 崩溃残留） → { status:'unknown' }（不发送）
   *   锁不可用 / 持久化降级 → { status:'deferred' }（不发送）
   *   send 抛错：
   *     delivery='maybe_sent'    → unknown（不自动重试）
   *     delivery='definitely_not_sent' → retryable（pending 保留）
   *     delivery='rejected' / 其它 → denied（不重试）
   */
  async execute({ key, sessionId, messages, send }) {
    if (this.corrupted) return { status: "deferred", reason: "state-file-corrupted" };
    if (this.degraded) return { status: "deferred", reason: "persistence-degraded" };

    const quick = this.stateOf(key);
    if (quick === "acknowledged") return { status: "duplicate" };
    if (quick === "denied") return { status: "denied", reason: "previously rejected by core; not retried" };

    const lockPath = await this.#acquireLock(key, 1500);
    if (lockPath === null) {
      return { status: "deferred", reason: "lock-unavailable" };
    }
    try {
      const state = this.stateOf(key);
      if (state === "acknowledged") return { status: "duplicate" };
      if (state === "unknown" || state === "sending") {
        // 已持锁仍见 sending：上一次尝试未完成（崩溃/断连）→ 结果未知
        if (state === "sending") await this.#set(key, "unknown", { via: "crash-recovery" });
        return { status: "unknown", reason: "previous attempt has unknown delivery; reconcile required" };
      }

      const persisted = await this.#set(key, "sending");
      if (!persisted) {
        // 无法持久化 sending：不发送（重启后无法判断是否重发）
        return { status: "deferred", reason: "persistence-degraded" };
      }

      try {
        const receipt = await send({ key, sessionId, messages });
        await this.#set(key, "acknowledged", { via: "ack" });
        return { status: "acknowledged", via: "ack", receipt };
      } catch (error) {
        const delivery = error?.delivery ?? "maybe_sent"; // 未分类错误保守按 maybe_sent
        if (delivery === "definitely_not_sent") {
          await this.#set(key, "pending");
          return { status: "retryable", error: String(error?.message ?? error) };
        }
        if (delivery === "rejected") {
          // 明确拒绝：回到 pending（未落库），但不自动重试；由调用方决定
          await this.#set(key, "denied", { reason: String(error?.message ?? error) });
          return { status: "denied", reason: String(error?.message ?? error) };
        }
        await this.#set(key, "unknown");
        return { status: "unknown", reason: "delivery unknown after send; not retried", error: String(error?.message ?? error) };
      }
    } finally {
      await this.#releaseLock(lockPath);
    }
  }

  /**
   * 对账：读回确认 unknown 的写入是否实际到达。
   * 内容命中只是"疑似"（suspected），不是服务端幂等证明。
   */
  async reconcile({ key, verify }) {
    const state = this.stateOf(key);
    if (state === "acknowledged") return { status: "acknowledged" };
    if (state !== "unknown" && state !== "sending") return { status: "skipped", reason: `state=${state ?? "none"}` };
    try {
      if (await verify({ key })) {
        await this.#set(key, "acknowledged", { via: "reconcile-suspected" });
        return { status: "acknowledged", via: "reconcile-suspected", suspected: true };
      }
    } catch {
      /* 对账失败保持 unknown */
    }
    return { status: "unknown", suspected: false };
  }
}
