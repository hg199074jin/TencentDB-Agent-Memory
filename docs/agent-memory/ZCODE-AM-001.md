# ZCODE-AM-001｜Agent Memory 模型无关四客户端升级 — 验收报告

- **Verdict：`PASS_WITH_IMPLEMENTATION_GATES`**（实现与验证全部完成；生产启用/部署加固为显式 Hard Gate，未执行）
- 分支：`feat/gpt-am-001-agent-memory`（基点 upstream `274e549`，本人 Fork `hg199074jin/TencentDB-Agent-Memory`）
- 报告路径：`docs/agent-memory/ZCODE-AM-001.md`（本里程碑同时产出 `M0-baseline.md`、`ARCHITECTURE.md`、`TEST-EVIDENCE.md`）
- 日期：2026-10-11 · 上游提案：TencentCloud/TencentDB-Agent-Memory#1631

## 1. 四客户端接入事实（全部实测验证）

| 客户端 | 版本 | verified source path | 事件 API | 身份映射 | 模型路由 |
| --- | --- | --- | --- | --- | --- |
| Codex | codex-cli `0.162.0` | `~/.codex/hooks.json` → `integrations/agent-memory/src/hook-cli.mjs`（生产现指向 macos-memory 工作区副本，**未改动**） | `UserPromptSubmit`/`Stop`（stdin JSON） | 五元组来自 `config.local.json`；`session_id="codex-"+sha256(session)[:24]`；turn=UserPromptSubmit→Stop（pending.submittedAt 为 turnId） | 保持原 provider（ChatGPT 应用授权），LLM 不经过 8096 |
| Claude Code | 本机 settings.json | `~/.claude/settings.json` → `hook-cli.mjs` | 同上 | 同上（`claude-` 前缀） | 保持原配置（zen 网关），不经过 8096 |
| ZCode | ZCode.app + CLI | `~/.zcode/cli/config.json` → `hook-cli.mjs` | 同上 | 同上（`zcode-` 前缀） | 保持原配置，不经过 8096 |
| OpenCode | `1.18.35` | `integrations/agent-memory/plugin/opencode-cross-agent-memory.js`（生产现指向 `~/.config/opencode/plugin/cross-agent-memory.js` 失控副本，**未改动**） | 插件钩子 `chat.message`/`experimental.chat.system.transform`/`event(message.updated,session.idle)` | 五元组同上；`session_id="opencode-"+sha256(session)[:24]`；turn=user message id | 任意 provider；`tencentdb-agent-memory`（代理）会话自动静默 |

四端共享同一授权作用域：team `个人跨 Agent 记忆` / agent `共享个人助手` / task `日常共享对话`（生产 ID 见 M0 §4；本分支测试用合成作用域）。

## 2. 仓库状态

| 项 | 值 |
| --- | --- |
| 官方 upstream `feat/server_team` HEAD | `274e549`（2026-10-10） |
| 本人 Fork `feat/server_team` HEAD | `fe3230f`（2026-08-06，陈旧，未用作 base） |
| 本功能分支 HEAD | `feat/gpt-am-001-agent-memory` @ `274e549` + 本里程碑提交（见 §7） |
| 生产部署 worktree | `/Volumes/ORICO/Projects/TencentDB-Agent-Memory`（detached `29d609a`，staged 改动**原样保留**） |
| 真实集成源码 worktree | `…-macos-memory`（`feat/macos-cross-agent-memory`，staged 未提交，**原样保留**） |
| 本分支 dirty/drift | 仅新增 `integrations/agent-memory/**` 与 `docs/agent-memory/**`（相对 upstream 274e549）；无 drift |

## 3. 实施内容（文件/接口/数据结构）

**新增 `integrations/agent-memory/`（自 macos-memory 真实生产源码演进，非凭空新造）：**

| 文件 | 内容 |
| --- | --- |
| `src/core-client.mjs` | v3 客户端；方法名与隔离字段对齐官方 SDK `@tencentdb-agent-memory/memory-sdk-ts-v2`（searchConversation/queryConversation/addConversation/searchAtomic/queryAtomic/listScenarios/readScenario/readCore、`team_id/agent_id/user_id/task_id`）；envelope 校验；`CoreTransportError`/`CoreApiError` 分类；AbortController 超时 |
| `src/identity.mjs` | 授权作用域：五元组完整性 + `allowed` allowlist；失配 → `{ok:false}`（fail-closed，无 default 兜底） |
| `src/recall.mjs` | 并行 L1+L3+L2(+L0)，逐层 allSettled 降级；条数/字符双预算；全值 XML 转义；query 剥离已注入块 |
| `src/capture.mjs` | 完整回合捕获（completed+非空 final；角色限 user/assistant；隐私检查）；`retryQueuedCaptures`（spool 重试带去重感知） |
| `src/privacy.mjs` | opt-out/凭据/data-URI 净化 + **注入记忆块剥离**（官方 OpenClaw sanitize 同款） |
| `src/dedupe.mjs` | `turnKey=SHA256(service,team,user,agent,client,session,turn)`；状态机 pending→sending→acknowledged/unknown；**跨进程文件锁 + 锁后重读**；持久化 `turns.json`；`reconcile()`/`markAcknowledged()` |
| `src/observability.mjs` | 无原文指标：计数/延迟分桶/失败分类/超预算 |
| `src/hook-cli.mjs` | 薄适配器（Codex/Claude/ZCode），CLI 契约不变 |
| `plugin/opencode-cross-agent-memory.js` | 薄适配器（OpenCode 1.18.x 插件钩子） |
| `test/*.test.mjs`（18 套） | 模块/契约/集成/E2E |

**迁移**：无数据库/schema 变更。服务端幂等键为**可选提案**（ARCHITECTURE §5），未实施。

## 4. A–H 验收结果（RED→GREEN，隔离实例实测）

| Gate | 结果 | 证据 |
| --- | --- | --- |
| A 模型无关 | **GREEN** | 隔离 E2E：hook（codex 线路）与插件（step-5 线路）各自 recall+write；请求只到 `:18420`，未触 8096；`e2e-isolated.test.mjs` gate A |
| B 跨客户端/越权 | **GREEN** | 客户端 A 写入的合成标记被客户端 B 召回；伪造 team（allowlist 外）零注入；服务端身份绑定缺口如实记录为 P0（§6） |
| C 记录准确 | **GREEN** | 30 次重复 Stop → L0 恰好 1 条；进程重启不重写；4 进程并发恰好 1 次发送（跨进程锁，`dedupe.test.mjs` D9 + E2E C3，连跑 3 次确定）；新 turn 正常新写 |
| D 故障隔离 | **GREEN** | Core `docker stop` 后 UserPromptSubmit <3s 返回 `{}`、Stop 正常响应；恢复后健康 |
| E 隐私信任 | **GREEN** | 6 类用例（opt-out×2/密钥×2/data-URI/注入块）0 泄漏；注入块剥离后干净文本仍入库 |
| F Proxy 共存 | **GREEN** | provider=`tencentdb-agent-memory` 会话：零注入零写入 |
| G 提炼效果 | **GREEN** | L0 ACK 后 Core 管线把合成决策提炼为 L1，`atomic/search` 48.8s 内可检索（非"仅写 L0"） |
| H 延迟预算 | **GREEN** | recall 5 采样 <1200ms；capture 3 采样 <3000ms（`e2e` gate H） |

命令：`npm test`（18 套 124 断言全绿，含 E2E；连跑 3 次稳定）。详细输出见 `TEST-EVIDENCE.md`。

## 5. 量化指标

- **漏报**：隐私用例 0 泄漏；注入块逃逸 0（转义断言 R2/E 门）。
- **重复**：重复事件 30×→1 条；重启→0 新增；并发 4 进程→1 次发送；unknown-ACK 0 次盲目重试。
- **召回相关性/预算**：注入块 ≤ `maxContextChars`（8000 合成配置 / 12000 生产默认）；每层条数硬截断（l1Limit/l2NavLimit/l0Limit）。
- **超时**：recall 1200ms / capture 3000ms 预算；Core 停服时 recall 全流程 <3s（fail-open）；超预算计数进 observability。
- **权限**：allowlist 伪造拒绝 100%（单测 I3 + E2E B）；服务端身份绑定缺口见 §6。
- **隐私风险残余**：凭据正则非完备保证（与官方 sanitize 同款口径），运维文档已声明。

## 6. 已知风险与剩余阻塞（诚实披露）

1. **P0（服务端，上游）**：Gateway 身份不绑定凭据——错误/缺失 `x-tdai-user-key` 实测可读写（M0 §5）。客户端 allowlist 是纵深一层，不是服务端 ACL。**生产启用前必须**：Gateway 绑 `127.0.0.1` 或设强 `TDAI_GATEWAY_API_KEY`；上游将 user-key 绑定 user_id 并校验 team/agent 归属（#1631 评论 D 项）。
2. **OpenCode `opencode run` 非交互模式**：assistant 完成事件缺 `time.completed`，该子模式不触发写入；TUI 不受影响（已记录）。
3. **OpenCode 2.x**：未覆盖（生产为 1.18.35）；2.x 插件钩子/配置结构需单独验证。
4. **服务端无 `idempotency_key`**：exactly-once 依仗客户端三重机制（持久化+读回+锁）；提案见 ARCHITECTURE §5。

## 7. 回滚与生产启用（只写方案，未执行）

**回滚本分支**：本分支未触碰任何生产文件；删除 worktree 即可（`git worktree remove`）。生产 hook/plugin 仍指向 macos-memory 工作区与 `~/.config/opencode/plugin/` 旧副本，行为与本分支实施前完全一致。

**生产启用步骤（需用户正式批准的 Hard Gate）**：
1. 部署侧加固：`tdai-gateway.yaml` 绑 `127.0.0.1`（或设 `TDAI_GATEWAY_API_KEY`），重启 core；
2. 将本分支 `integrations/agent-memory/` 同步为生产目录（或指针切换），`node src/doctor.mjs` 全绿；
3. `node src/install-hooks.mjs install` 重挂三客户端 hook；`~/.config/opencode/plugin/` 换为本分支插件副本/软链接；
4. 灰度：先 OpenCode 一个会话验证注入/写入，再开 codex/claude/zcode；
5. 回滚：恢复 macos-memory 工作区版本与旧插件副本 + 原 gateway 配置。

**唯一下一 Hard Gate**：§6.1 的生产部署侧加固（Gateway loopback/强 key + 上游身份绑定）——未批准前不得生产启用。

## 8. 提交与远端

- commit：`e6a2873` feat(agent-memory): model-agnostic four-client shared memory (GPT-AM-001)
- 分支：https://github.com/hg199074jin/TencentDB-Agent-Memory/tree/feat/gpt-am-001-agent-memory
- 报告直链：https://github.com/hg199074jin/TencentDB-Agent-Memory/blob/feat/gpt-am-001-agent-memory/docs/agent-memory/ZCODE-AM-001.md
- PR：**不创建**（Fork 默认分支 `fe3230f` 陈旧两个月，建 PR 会把大量 upstream 提交包进 diff；留在可审查功能分支）
- 官方公开 PR：**未提交**（未授权）
