import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DEFAULT_RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url));
const MAX_QUEUE_BYTES = 20 * 1024 * 1024;
const ORPHAN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 60;
const LOCK_RETRY_MS = 10;

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function runtimePath(options) {
  return typeof options?.runtimeDir === "string" && options.runtimeDir !== ""
    ? options.runtimeDir
    : DEFAULT_RUNTIME_DIR;
}

function pendingDigest(client, sourceSessionId) {
  return sha256(`${String(client).toLowerCase()}\0${String(sourceSessionId)}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanOrphanedPending(runtimeDir, injectedFs = {}) {
  const fs = { readdir, rename, stat, unlink, link, ...injectedFs };
  const pendingDir = join(runtimeDir, "pending");
  let entries;
  try {
    entries = await fs.readdir(pendingDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") return;
    return;
  }
  const threshold = Date.now() - ORPHAN_AGE_MS;
  for (const entry of entries.filter((candidate) => candidate.isFile() && /^[a-f0-9]{64}\.json$/.test(candidate.name))) {
    const canonical = join(pendingDir, entry.name);
    const claim = join(pendingDir, `.${entry.name}.${process.pid}.${randomUUID()}.cleanup-claim`);
    try {
      await fs.rename(canonical, claim);
    } catch {
      continue;
    }
    try {
      if ((await fs.stat(claim)).mtimeMs < threshold) {
        await fs.unlink(claim);
        continue;
      }
      try {
        await fs.link(claim, canonical);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await fs.unlink(claim);
    } catch {
      try {
        await fs.link(claim, canonical);
        await fs.unlink(claim);
      } catch {
        // A newer canonical wins; otherwise a later cleanup can recover the claim.
      }
    }
  }
}

async function writeDurable(path, source) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function logWarning(runtimeDir, code) {
  try {
    await appendFile(
      join(runtimeDir, "warnings.log"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), code })}\n`,
      "utf8"
    );
  } catch {
    // Logging is also fail-open and never includes turn content.
  }
}

async function acquireQueueLock(runtimeDir) {
  const lockDir = join(runtimeDir, "capture-queue.lock");
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockDir);
      return lockDir;
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
      try {
        if (Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Another process may have released the lock between checks.
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  return null;
}

async function releaseQueueLock(lockDir) {
  if (!lockDir) return;
  try {
    await rm(lockDir, { recursive: true, force: true });
  } catch {
    // A stale lock is reclaimed by a later Hook.
  }
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "",
      content: typeof message.content === "string" ? message.content : "",
      timestamp: typeof message.timestamp === "string" ? message.timestamp : ""
    }));
}

function normalizeCapture(record) {
  const core = {
    memorySessionId: typeof record?.memorySessionId === "string" ? record.memorySessionId : "",
    messages: cleanMessages(record?.messages),
    queuedAt: typeof record?.queuedAt === "string" ? record.queuedAt : new Date().toISOString()
  };
  const digest = sha256(JSON.stringify({ memorySessionId: core.memorySessionId, messages: core.messages }));
  return { ...core, digest };
}

function isValidQueuedRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record.memorySessionId !== "string" || record.memorySessionId === "") return false;
  if (typeof record.queuedAt !== "string" || !Number.isFinite(new Date(record.queuedAt).getTime())) return false;
  if (!Array.isArray(record.messages) || record.messages.length === 0) return false;
  if (!record.messages.every((message) =>
    message && typeof message === "object" && !Array.isArray(message) &&
    typeof message.role === "string" && typeof message.content === "string" &&
    typeof message.timestamp === "string" && Number.isFinite(new Date(message.timestamp).getTime()))) return false;
  return record.digest === sha256(JSON.stringify({
    memorySessionId: record.memorySessionId,
    messages: record.messages
  }));
}

async function readQueue(queuePath) {
  let source;
  try {
    source = await readFile(queuePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (source === "") return [];
  return source
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function queueSource(records) {
  return records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function replaceQueue(runtimeDir, records) {
  const queuePath = join(runtimeDir, "capture-queue.jsonl");
  const token = `${process.pid}-${randomUUID()}`;
  const buildingPath = join(runtimeDir, `.capture-queue-rebuild-${token}.building`);
  const readyPath = join(runtimeDir, `.capture-queue-rebuild-${token}.ready`);
  await writeDurable(buildingPath, queueSource(records));
  await rename(buildingPath, readyPath);
  try {
    await rename(readyPath, queuePath);
    return true;
  } catch {
    await logWarning(runtimeDir, "capture_queue_replace_failed");
    return false;
  }
}

async function pendingQueueFiles(runtimeDir) {
  const spoolDir = join(runtimeDir, "capture-spool");
  let names;
  try {
    names = await readdir(spoolDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".pending")).sort().map((name) => join(spoolDir, name));
}

async function recoverRetainedRebuild(runtimeDir) {
  let names;
  try {
    names = await readdir(runtimeDir);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const buildingNames = names.filter((name) =>
    name.startsWith(".capture-queue-rebuild-") && name.endsWith(".building"));
  await Promise.all(buildingNames.map(async (name) => {
    try { await removeIfExists(join(runtimeDir, name)); } catch { /* Never promote incomplete builds. */ }
  }));
  const readyNames = names.filter((name) =>
    name.startsWith(".capture-queue-rebuild-") && name.endsWith(".ready"));
  if (readyNames.length === 0) return true;

  const candidates = await Promise.all(readyNames.map(async (name) => {
    const path = join(runtimeDir, name);
    return { path, mtimeMs: (await stat(path)).mtimeMs };
  }));
  const validCandidates = [];
  for (const candidate of candidates) {
    try {
      const source = await readFile(candidate.path, "utf8");
      if (source !== "" && !source.endsWith("\n")) throw new Error("incomplete JSONL");
      const lines = source === "" ? [] : source.slice(0, -1).split("\n");
      if (lines.some((line) => line === "")) throw new Error("blank JSONL record");
      const records = lines.map((line) => JSON.parse(line));
      if (!records.every(isValidQueuedRecord)) throw new Error("invalid queue record");
      validCandidates.push(candidate);
    } catch {
      try { await rename(candidate.path, `${candidate.path}.invalid`); } catch { /* Preserve in place if quarantine fails. */ }
    }
  }
  if (validCandidates.length === 0) return true;
  validCandidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const newest = validCandidates.at(-1);
  try {
    await rename(newest.path, join(runtimeDir, "capture-queue.jsonl"));
  } catch {
    await logWarning(runtimeDir, "capture_queue_recovery_failed");
    return false;
  }
  await Promise.all(validCandidates.slice(0, -1).map(async ({ path }) => {
    try { await removeIfExists(path); } catch { /* Obsolete recovery files contain no new data. */ }
  }));
  return true;
}

async function consolidateQueue(runtimeDir) {
  const queuePath = join(runtimeDir, "capture-queue.jsonl");
  if (!await recoverRetainedRebuild(runtimeDir)) {
    return { ok: false, records: await readQueue(queuePath), rejected: new Set() };
  }
  const records = await readQueue(queuePath);
  const known = new Set(records.map((record) => record?.digest ?? sha256(JSON.stringify(record))));
  const spoolPaths = await pendingQueueFiles(runtimeDir);
  const consumed = [];
  const rejected = new Set();
  let bytes = Buffer.byteLength(queueSource(records), "utf8");

  for (const spoolPath of spoolPaths) {
    let record;
    try {
      record = JSON.parse(await readFile(spoolPath, "utf8"));
    } catch {
      continue;
    }
    consumed.push(spoolPath);
    if (known.has(record.digest)) continue;
    const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes + lineBytes > MAX_QUEUE_BYTES) {
      rejected.add(record.digest);
      await logWarning(runtimeDir, "capture_queue_full");
      continue;
    }
    records.push(record);
    known.add(record.digest);
    bytes += lineBytes;
  }

  if (spoolPaths.length > 0) {
    if (!await replaceQueue(runtimeDir, records)) return { ok: false, records, rejected };
    await Promise.all(consumed.map(async (path) => {
      try { await removeIfExists(path); } catch { /* The digest prevents replay duplicates. */ }
    }));
  }
  return { ok: true, records, rejected };
}

export function makeMemorySessionId(client, sourceSessionId) {
  const prefix = String(client).trim().toLowerCase();
  return `${prefix}-${sha256(sourceSessionId).slice(0, 24)}`;
}

export async function savePendingTurn(
  { client, sourceSessionId, prompt, skip, submittedAt },
  options = {}
) {
  const runtimeDir = runtimePath(options);
  const pendingDir = join(runtimeDir, "pending");
  const digest = pendingDigest(client, sourceSessionId);
  const target = join(pendingDir, `${digest}.json`);
  const temporary = join(pendingDir, `${digest}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(pendingDir, { recursive: true });
    await cleanOrphanedPending(runtimeDir, options.fs);
    await writeDurable(temporary, JSON.stringify({
      client: String(client).toLowerCase(),
      prompt: typeof prompt === "string" ? prompt : "",
      skip: Boolean(skip),
      submittedAt: new Date(submittedAt).toISOString()
    }));
    await rename(temporary, target);
    return true;
  } catch {
    try { await removeIfExists(temporary); } catch { /* Fail open. */ }
    return false;
  }
}

export async function takePendingTurn({ client, sourceSessionId }, options = {}) {
  const runtimeDir = runtimePath(options);
  const target = join(runtimeDir, "pending", `${pendingDigest(client, sourceSessionId)}.json`);
  const claim = join(runtimeDir, "pending", `.${pendingDigest(client, sourceSessionId)}.${process.pid}.${randomUUID()}.take-claim`);
  const fs = { rename, readFile, unlink, ...options.fs };
  try {
    await fs.rename(target, claim);
    await cleanOrphanedPending(runtimeDir, options.fs);
    const pending = JSON.parse(await fs.readFile(claim, "utf8"));
    await fs.unlink(claim);
    return pending;
  } catch {
    return null;
  }
}

export async function enqueueCapture(record, options = {}) {
  const runtimeDir = runtimePath(options);
  const normalized = normalizeCapture(record);
  const spoolDir = join(runtimeDir, "capture-spool");
  const spoolPath = join(spoolDir, `${Date.now()}-${process.pid}-${randomUUID()}.pending`);
  let durable = false;
  try {
    await mkdir(spoolDir, { recursive: true });
    await writeDurable(spoolPath, JSON.stringify(normalized));
    durable = true;
    const lockDir = await acquireQueueLock(runtimeDir);
    if (!lockDir) return true;
    try {
      const result = await consolidateQueue(runtimeDir);
      if (!result.ok) return true;
      return !result.rejected.has(normalized.digest) &&
        result.records.some((queued) => queued?.digest === normalized.digest);
    } finally {
      await releaseQueueLock(lockDir);
    }
  } catch {
    return durable;
  }
}

export async function drainCaptureQueue(limit, handler, options = {}) {
  const runtimeDir = runtimePath(options);
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
  let lockDir;
  try {
    await mkdir(runtimeDir, { recursive: true });
    lockDir = await acquireQueueLock(runtimeDir);
    if (!lockDir) return { processed: 0, removed: 0, remaining: 0, stopped: true };
    const consolidated = await consolidateQueue(runtimeDir);
    if (!consolidated.ok) {
      return { processed: 0, removed: 0, remaining: consolidated.records.length, stopped: true };
    }
    const records = consolidated.records;
    let processed = 0;
    let removed = 0;
    let stopped = false;

    for (const record of records.slice(0, safeLimit)) {
      processed += 1;
      let handled = false;
      try {
        handled = await handler(record) === true;
      } catch {
        handled = false;
      }
      if (!handled) {
        stopped = true;
        break;
      }
      removed += 1;
    }

    if (removed > 0) {
      const remainingRecords = records.slice(removed);
      if (!await replaceQueue(runtimeDir, remainingRecords)) {
        return { processed, removed: 0, remaining: records.length, stopped: true };
      }
    }
    return { processed, removed, remaining: records.length - removed, stopped };
  } catch {
    return { processed: 0, removed: 0, remaining: 0, stopped: true };
  } finally {
    await releaseQueueLock(lockDir);
  }
}
