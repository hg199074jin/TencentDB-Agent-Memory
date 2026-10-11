const REMOVED_MEDIA = "[已移除多媒体数据]";
const DATA_URI_PATTERN = /data:[^,\s]*;base64,[A-Za-z0-9+/=]+/gi;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/=]{400,}/g;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /(?:\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|pwd|token)\b|密码)\s*["'＂”’」』]\s*[:=：＝]\s*["'＂“‘「『]?\s*[^\s,;，；:=：＝"'＂“”‘’「」『』{}\[\]]+/iu,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /(?:\b(?:password|passwd|pwd|token)\b|密码)\s*[:=：＝]\s*[^\s,;，；:=：＝]+/iu,
  /\bsk-[A-Za-z0-9_-]+/i,
  /\bghp_[A-Za-z0-9]+/i,
  /\bgithub_pat_[A-Za-z0-9_]+/i
];

function asText(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 已注入记忆块清单（官方 OpenClaw sanitize.ts 同款 + 本实现的包裹标签）。
 * capture 前必须剥离，防止"注入的历史块"被当作用户输入写回 L0（回环污染）。
 */
const INJECTED_BLOCK_PATTERNS = [
  /<cross-agent-memory[\s\S]*?<\/cross-agent-memory>/gi,
  /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
  /<user-persona>[\s\S]*?<\/user-persona>/gi,
  /<relevant-scenes>[\s\S]*?<\/relevant-scenes>/gi,
  /<scene-navigation>[\s\S]*?<\/scene-navigation>/gi,
  /<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/gi,
  /<current_task_context>[\s\S]*?<\/current_task_context>/gi,
  /<history_task_context[\s\S]*?<\/history_task_context>/gi,
];

/** 剥离文本中已注入的记忆块（未闭合的块按剥离到末尾处理）。 */
export function stripInjectedMemoryBlocks(text) {
  let value = asText(text);
  for (const pattern of INJECTED_BLOCK_PATTERNS) {
    value = value.replace(pattern, "");
  }
  // 未闭合包裹（截断/流式场景）：从开标签处截断
  const open = value.search(/<cross-agent-memory[\s>]/i);
  if (open >= 0) value = value.slice(0, open);
  return value.trim();
}

export function hasNoMemoryDirective(text) {
  const value = asText(text);
  return /\[不记忆\]/i.test(value) || /\/nomemory(?![\p{L}\p{N}_])/iu.test(value);
}

export function containsCredential(text) {
  const value = asText(text);
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeText(text, limit) {
  return asText(text)
    .replace(DATA_URI_PATTERN, REMOVED_MEDIA)
    .replace(LONG_BASE64_PATTERN, REMOVED_MEDIA)
    .slice(0, limit);
}

export function inspectTurn(user, assistant) {
  const userText = stripInjectedMemoryBlocks(asText(user));
  const assistantText = asText(assistant);

  return {
    skip: hasNoMemoryDirective(userText) ||
      hasNoMemoryDirective(assistantText) ||
      containsCredential(userText) ||
      containsCredential(assistantText),
    user: sanitizeText(userText, 30_000),
    assistant: sanitizeText(assistantText, 60_000)
  };
}
