// privacy.mjs — 追加注入块剥离契约（RED，扩展现有 privacy）
import assert from "node:assert/strict";
import { inspectTurn, stripInjectedMemoryBlocks } from "../src/privacy.mjs";

// P1: 既有 opt-out / 凭据 / data-uri 行为不回退（data-uri 为替换占位，不是整轮跳过）
{
  assert.equal(inspectTurn("[不记忆] 秘密", "").skip, true);
  assert.equal(inspectTurn("/nomemory 秘密", "").skip, true);
  assert.equal(inspectTurn("api_key = sk-abcdefghijklmnop", "").skip, true);
  assert.equal(inspectTurn("Bearer abcdefghijklmnop", "").skip, true);
  const dataUri = inspectTurn("data:text/plain;base64,QUJD", "");
  assert.equal(dataUri.skip, false);
  assert.ok(!dataUri.user.includes("base64,QUJD"), "data-uri payload must not be recorded");
  assert.equal(inspectTurn("正常对话", "正常回答").skip, false);
  console.log("P1 legacy privacy rules intact: PASS");
}

// P2: 剥离官方/本实现的注入记忆块（防回环写入）
{
  const cases = [
    '<cross-agent-memory trust="historical-reference-only">旧</cross-agent-memory>新输入',
    "前缀<relevant-memories>a</relevant-memories>后缀",
    "a<user-persona>b</user-persona>c",
    "x<scene-navigation>y</scene-navigation>z",
    "m<memory-tools-guide>n</memory-tools-guide>o",
  ];
  for (const input of cases) {
    const cleaned = stripInjectedMemoryBlocks(input);
    assert.ok(!cleaned.includes("cross-agent-memory"), input);
    assert.ok(!cleaned.includes("relevant-memories"), input);
    assert.ok(!cleaned.includes("user-persona"), input);
    assert.ok(!cleaned.includes("scene-navigation"), input);
    assert.ok(!cleaned.includes("memory-tools-guide"), input);
  }
  console.log("P2 injected blocks stripped: PASS");
}

// P3: 含注入块的 user 文本经 inspectTurn 后不再含块（capture 净化链路）
{
  const inspected = inspectTurn(
    '<cross-agent-memory trust="historical-reference-only">旧记忆</cross-agent-memory>真实问题',
    "回答",
  );
  assert.equal(inspected.skip, false);
  assert.ok(!inspected.user.includes("cross-agent-memory"));
  assert.ok(inspected.user.includes("真实问题"));
  console.log("P3 inspectTurn sanitizes injected blocks: PASS");
}
