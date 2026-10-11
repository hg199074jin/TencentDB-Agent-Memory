# M0 基线盘点（只读核实）

> GPT-AM-001 · Agent Memory 模型无关四客户端升级 · 2026-10-11
> 本文所有结论来自本机只读核实（git/容器/配置/源码），未改动任何生产文件与服务。

## 1. 仓库与分支事实

| 项 | 值 | 核实方式 |
| --- | --- | --- |
| 官方 upstream `origin/feat/server_team` HEAD | `274e549`（2026-10-10 10:31 +0800） | `git fetch origin` + `git log -1` |
| 官方 upstream `origin/main` HEAD | `18571c4`（落后 feat/server_team） | 同上 |
| 本人 Fork `user/feat/server_team` HEAD | `fe3230f`（2026-08-06，"Update package.json"） | `git fetch user` + `git log -1` |
| Fork 其他分支 | `user/fix/windows-gitbash-deploy`、`user/handoff/gpt-am-001-20261011`、`user/personal-integration` | 同上 |
| 生产部署 worktree | `/Volumes/ORICO/Projects/TencentDB-Agent-Memory`（detached HEAD `29d609a` = v2.0.1-beta.2 tag，工作区 staged 着 v2.0.2 内容与本地 chmod 加固，**未提交**） | `git status` |
| 真实集成源码 worktree | `/Volumes/ORICO/Projects/TencentDB-Agent-Memory-macos-memory`（分支 `feat/macos-cross-agent-memory`，基点 `29d609a`，`integrations/cross-agent-memory/**` **全部 staged 未 commit**，含未跟踪 `.gitignore`、`test/opencode-plugin.test.mjs`） | `git status` |
| OpenCode 生产插件 | `~/.config/opencode/plugin/cross-agent-memory.js`（16624 B，**不受版本控制**，与 test/opencode-plugin.test.mjs 为同一实现的副本） | `ls` |
| 本里程碑 worktree | `/Volumes/ORICO/Projects/TencentDB-Agent-Memory-GPT-AM-001`，分支 `feat/gpt-am-001-agent-memory`，基点 **upstream `274e549`**（非旧 Fork） | `git worktree add` |

**结论**：真实生产源码 = `TencentDB-Agent-Memory-macos-memory` worktree 工作区（staged 未提交）+ `~/.config/opencode/plugin/`（失控副本）。实施 base 已按指令建于 upstream HEAD `274e549` 的新 worktree/功能分支；旧 Fork 分支 `fe3230f` 未被动用。

## 2. 运行中服务（生产，未改动）

| 容器 | 镜像 | 状态 | 端口 |
| --- | --- | --- | --- |
| `tdai-memory-core` | `agentmemory/memory-core:latest`（v2.0.2 代） | healthy，uptime 429s+（本会话早期按 GLM 切换重启过一次，之后未再动） | 8420 |
| `tdai-memory-hub` | `agentmemory/memory-hub:latest` | healthy | 8125 / 8424 |
| `tdai-proxy` | `agentmemory/memory-proxy:latest` | healthy | 8096 |

- `/health`：core `{"status":"ok","version":"0.1.0","stores":{"vectorStore":true,"embeddingService":false}}`；hub `200`；proxy `200`。
- 上游 LLM：`https://open.bigmodel.cn/api/paas/v4`，模型 `glm-5.3-flash`（本机 `.env`，密钥不入库）。
- 共享记忆块：`chat_memory-team-c09kid744t-agt-c09kvch8lv`，L0 累计 **5249** 条（生产只读统计，未输出原文）。

## 3. 四客户端安装与接入事实（脱敏）

| 客户端 | 版本 | 接入方式 | 事件 | Session/Turn ID 来源 |
| --- | --- | --- | --- | --- |
| Codex | codex-cli `0.162.0` | `~/.codex/hooks.json` → `node <integration>/src/hook-cli.mjs codex` | `UserPromptSubmit`（召回）、`Stop`（写入）、`PermissionRequest`（已挂但当前适配器不处理） | hook stdin `session_id`；turn 边界 = 一次 UserPromptSubmit→Stop |
| Claude Code | 本机 settings.json（版本字段未单列） | `~/.claude/settings.json` → `hook-cli.mjs claude` | `UserPromptSubmit`、`Stop`（另有 agent-workstation 钩子，非本次范围） | 同上 |
| ZCode | ZCode.app + CLI | `~/.zcode/cli/config.json` → `hook-cli.mjs zcode` | `UserPromptSubmit`、`Stop` | 同上 |
| OpenCode | `1.18.35`（1.x 线） | 插件 `~/.config/opencode/plugin/cross-agent-memory.js`（**失控副本，未入 git**） | `chat.message`（召回+补写上轮）、`experimental.chat.system.transform`（注入）、`event` 的 `message.updated`/`session.idle`（写入） | 插件 `input.sessionID`；turn = user message id（`input.messageID ?? output.message.id`） |

四端共用同一份配置：`integrations/cross-agent-memory/config.local.json`（`endpoint=127.0.0.1:8420`、`hubEndpoint=127.0.0.1:8125`、`serviceId=default`、身份四元组见 §5）。

## 4. 每客户端调用链（prompt→recall→inject→LLM→end turn→capture→Core）

```text
Codex/Claude/ZCode（hook-cli.mjs，薄 CLI 适配）:
  UserPromptSubmit ──► privacy.inspectTurn(user) ──► [skip?] ──► savePendingTurn(本地 pending)
                   └─► recallCrossSession(GatewayClient) = 并发 /v3/conversation/search + /v3/atomic/search + /v3/core/read
                   └─► 输出 hookSpecificOutput.additionalContext（<cross-agent-memory trust=...> 包裹）
  Stop ──► takePendingTurn（取出原始终 user 文本）──► captureTurn ──► /v3/conversation/add（失败入 durable spool 重试）

OpenCode（plugin，薄适配）:
  chat.message ──► 先 captureTurn(上一轮, 幂等键) ──► recall(用户输入) ──► 缓存
  experimental.chat.system.transform ──► output.system.push(召回块)；provider==tencentdb-agent-memory 时跳过
  message.updated(assistant completed) / session.idle ──► captureTurn(本轮) ──► /v3/conversation/add
```

身份/作用域如何决定共享：
- **写侧**：`/v3/conversation/add` body 带 `team_id/agent_id/user_id/task_id + session_id`，`session_id = "<client>-<sha256(sourceSessionId)[:24]>"`（客户端命名空间隔离，同 team/agent 下四端 L0 汇流到同一 `chat_memory-team-*-agt-*` 块）。
- **读侧**：recall 三个检索端点同样带身份四元组；L1/L3 为 team+agent 作用域。
- **无默认兜底**：现行实现要求在 `config.local.json` 显式配置四元组；缺失字段时 GatewayClient 构造即抛错（fail-closed 雏形，但尚无"授权白名单"概念）。

## 5. 身份与权限模型（含 P0 发现）

身份（非机密，仅 ID）：`teamId=team-c09kid744t`（"个人跨 Agent 记忆"）、`agentId=agt-c09kvch8lv`（"共享个人助手"）、`taskId=task-c09ke93bsu`、`userId=usr-cxrdrdfl5y`、`serviceId=default`。

**v3 auth 实况（本机实测）**：

| 场景 | 结果 |
| --- | --- |
| Gateway Bearer = 部署默认兼容值 + 正确 `x-tdai-user-key` | `code 0`，正常检索 |
| **错误 user-key（`sk-mem-0000…`）+ 真实身份四元组** | **`code 0`，返回真实记忆数据** |
| **完全不带 user-key + 真实身份四元组** | **`code 0`，返回真实记忆数据** |
| 正确 key + 伪造 `team-forged999` | `code 0`（空数据，但不报越权） |
| Core 容器启动日志 | `Security posture: auth=disabled host=0.0.0.0` + WARN"all routes except GET /health are open to anyone who can reach this port" |

**结论（P0，须进报告）**：Gateway 目前只有"可选的服务级 Bearer"（本部署未启用，用 legacy 兼容值），**身份四元组来自请求 body/header 且被直接信任，不与任何凭据绑定**。即：任何能到达 8420 的进程都可声称任意 team/agent/user 读写。业务 `sk-mem` key 与 Gateway Token 不是同一层鉴权；三元组隔离不是用户级 ACL。这对"hook/plugin 直连"路径是结构性风险。

**最小权限方案（本里程碑落地 + 生产 Hard Gate）**：
1. 客户端侧（本次实现）：`identity.mjs` 授权作用域白名单 + fail-closed（配置缺失/不匹配/越权 → 拒绝 recall 与 capture，Agent 继续，不落入 default）。
2. 部署侧（生产启用前的 Hard Gate，本次只写方案不执行）：Gateway 绑 `127.0.0.1`（或设 `TDAI_GATEWAY_API_KEY`）；由受控本机 bridge 集中持 key；上游侧建议 Gateway 将 `x-tdai-user-key` 绑定到 user_id 并校验 team/agent 归属（对应官方 Issue #1631 评论中的 D 项）。

## 6. 官方参考实现核对（upstream `274e549`）

| 参考 | 关键契约 |
| --- | --- |
| `MemoryCore/openclaw-plugin/src/hooks/recall.ts` | 并发 `searchAtomic` + `readCore` + `listScenarios`，逐项 `allSettled` 降级 |
| `.../hooks/capture.ts` | 位置切片 + 时间戳游标只取本回合；用 `before_prompt_build` 缓存的原始终 user 文本替换污染消息；服务端为 L0 权威 |
| `.../sanitize.ts` | 剥离既有注入块（`<relevant-memories>` 等 6 类）防回环；IM 元数据/媒体占位清理 |
| `sdk/memory-core/typescript`（npm `@tencentdb-agent-memory/memory-sdk-ts-v2@1.0.1-beta.1`） | `V3IsolationContext{team_id,agent_id,user_id,session_id?,task_id?}`；方法名 `addConversation/queryConversation/searchConversation/searchAtomic/queryAtomic/listScenarios/readScenario/readCore` |
| `V3ConversationAddRequest` | **不含 `idempotency_key`** → exactly-once 需客户端持久化幂等 + 读回校验（M2），服务端幂等键作为对上游的可选提案（不改生产 schema） |

本机实现（`gateway-client.mjs`）端点与官方 SDK v3 一致（envelope `{code,message,request_id,data}` 校验齐备），本次将其收敛为 `core-client.mjs` 并对齐 SDK 方法名与隔离上下文字段。

## 7. 可修改路径与风险/未知项

**可修改（本里程碑范围）**：新 worktree `/Volumes/ORICO/Projects/TencentDB-Agent-Memory-GPT-AM-001`（`integrations/agent-memory/**`、`docs/agent-memory/**`）；本人 Fork 功能分支推送。

**不可触碰**：生产 worktree、macos-memory worktree 工作区（staged 未提交，保留原状）、运行中容器与 `.env`、`~/.config/opencode/`、`~/.codex/hooks.json`、`~/.claude/settings.json`、`~/.zcode/cli/config.json`、生产 L0 数据。

**风险/未知项**：
1. **P0**：Gateway 身份不绑定凭据（§5）——生产启用前必须部署侧加固，客户端白名单只是纵深一层。
2. OpenCode 1.18.35 的 `chat.message` 钩子 `input.messageID` 实测为 `undefined`（用 `output.message.id` 兜底）；2.x 线配置结构不同（`providers/package/settings`），插件需特征检测（M1 落地）。
3. `opencode run`（非交互）assistant 完成事件不带 `time.completed`，该模式不触发写入（TUI 正常）——已知限制，报告中明示。
4. Codex `PermissionRequest` 事件已挂 hook-cli 但无处理分支（无害，保持）。
5. 生产 5249 条 L0 不做任何清理/迁移/重写（另立审批）。
6. Fork 默认分支陈旧（`fe3230f`）；本功能分支直接推 Fork，**不建 PR**（避免把数月 upstream 提交包进 diff）。

**Hard Gate 检查**：未发现"真实代码源缺失/必须改运行配置/生产漂移不明"——生产服务健康、源码位置已全部定位、身份配置明确。P0 权限问题以"客户端 fail-closed + 部署侧方案"处理，不阻断隔离开发。→ **进入 M1**。
