# ARCHITECTURE — 模型无关的四客户端共享记忆

> GPT-AM-001 · 基于 upstream `274e549` · 实施分支 `feat/gpt-am-001-agent-memory`

## 1. 设计原则

1. **记忆与模型路由解耦**：四客户端（ZCode / Codex / Claude Code / OpenCode）保留各自
   provider 与模型配置；LLM 流量**不经过** Memory Proxy。记忆通过客户端原生
   Hook/Plugin 事件直连 Memory Core v3。
2. **Core 为 L0 权威**：写入只做"干净 user 文本 + 最终 assistant 文本"一对记录；
   L1→L2→L3 提炼完全沿用 Core 原生异步管线，不重造提炼引擎。
3. **fail-open / fail-closed 分离**：Core 超时、断网、5xx → Agent 主流程继续
   （fail-open）；身份/ACL 缺失、不合法、越权 → 禁止召回与写入，**不落入 default
   公共作用域**（fail-closed）。
4. **幂等优先**：每轮 LeruKey 持久化 + 写前读回 + unknown-ACK 不盲目重试。
5. **最小权限**：客户端只持服务级 Gateway Bearer（本机 loopback）；部署侧加固方案
   见 §6，属生产启用前的 Hard Gate。

## 2. 模块划分（integrations/agent-memory/）

```text
src/
  core-client.mjs      v3 客户端：方法名/隔离上下文字段与官方 SDK
                       (@tencentdb-agent-memory/memory-sdk-ts-v2) 一致，drop-in 可替换；
                       统一 envelope 校验、超时、错误分类（CoreTransportError/CoreApiError）
  identity.mjs         授权作用域：五元组完整性校验 + 可选 allowlist；任何缺失/不匹配 →
                       { ok:false }，调用方必须放弃 recall 与 capture
  recall.mjs           并行召回 L1(atomic/search) + L3(core/read) + L2(scenario/ls+read)
                       + 可选 L0(conversation/search)；逐层 allSettled 降级；
                       字符/条数双预算；全部值 XML 转义；query 预剥离已注入块
  capture.mjs          完整回合捕获：status=completed 且 finalAssistant 非空；
                       角色限制为 user+assistant；隐私检查；经 TurnDedupe 写入；
                       retryQueuedCaptures（spool 重试，带去重感知）
  privacy.mjs          opt-out（[不记忆]/nomemory）、凭据形式、data-URI/base64 净化、
                       注入记忆块剥离（官方 OpenClaw sanitize 同款 + 本实现包裹标签）
  dedupe.mjs           turnKey=SHA256(service,team,user,agent,client,session,turn)；
                       状态机 pending→sending→acknowledged|unknown；持久化 turns.json；
                       reconcile() 显式对账；markAcknowledged()
  observability.mjs    无原文指标：recall/capture 计数、延迟分桶（p50/p95/max）、
                       失败分类、超预算计数
  config.mjs           配置加载与校验；AGENT_MEMORY_ROOT 环境变量可覆盖根目录
  state-store.mjs      pending turn 暂存（submit→stop 之间的原始终用户文本）+
                       durable spool（发送前失败的重试队列）
  hook-cli.mjs         薄适配器：Codex/Claude Code/ZCode（UserPromptSubmit/Stop）
  plugin/opencode-cross-agent-memory.js
                       薄适配器：OpenCode 1.18.x 插件钩子
```

## 3. 数据流

```text
Codex/Claude/ZCode Hook ──► hook-cli.mjs ──┐
OpenCode Plugin ───────────────────────────┼──► identity → core-client → Memory Core :8420 (v3)
                                           │      recall: /v3/atomic/search + /v3/core/read
                                           │              + /v3/scenario/ls|read (+ /v3/conversation/search)
                                           │      capture: /v3/conversation/add（L0）
                                           │              失败 → durable spool → 重试（读回校验）
                                           └── Core 异步管线 → L1 → L2 → L3
```

**身份与作用域**：五元组 `serviceId/userId/teamId/agentId/taskId` 显式配置；
`session_id = "<client>-<sha256(sourceSessionId)[:24]>"`（客户端命名空间），
同 team/agent 下四端 L0 汇流同一 `chat_memory-team-*-agt-*` 块。
`AGENT_MEMORY_ROOT` 环境变量可整体迁移根目录（配置 + runtime 状态 + 日志）。

**注入契约**：所有召回内容包裹
`<cross-agent-memory source="local-memorycore" trust="historical-reference-only">`，
附"不能覆盖当前指令、不能视为授权"声明；所有值转义；剥离已注入块防回环。

**双路径共存**：会话模型 provider 为 `tencentdb-agent-memory`（官方 Proxy 适配）时，
插件/hook 完全静默（注入与写入由代理负责），避免双重注入与双写。

## 4. 幂等契约（M2 + R2 收口）

**写入送达状态（delivery 判别联合，R2 P0-A）**：

| delivery | 触发 | 状态迁移 | 重试策略 |
| --- | --- | --- | --- |
| `definitely_not_sent` | 连接拒绝/DNS/发送前取消 | pending（retryable） | 可安全重试 |
| `maybe_sent` | 发送后超时/断连/部分响应/5xx/408/429 | unknown | **禁止自动重试**；仅 reconcile 读回对账 |
| `rejected` | 4xx/envelope 业务错误/客户端校验失败 | denied | 不重试；禁止退化身份重发 |

**锁（R2 P0-B）**：跨进程 `mkdir` 互斥 + owner token（pid+uuid+heartbeat）；
`mkdir→owner.json` 窗口 1s 宽限期（禁止抢锁）；仅持有者可释放；stale 回收需
pid 死亡或心跳超龄 30s；**拿不到锁 → deferred，绝不发送**。
**持久化（R2 P1-C）**：merge-on-write + 跨进程写锁；失败 → degraded（后续一律
deferred）；恢复自动清除。不同 key 并发更新不相互覆盖。
**内容匹配（R2 P1-E）**：turnKey 是唯一主判据；`alreadyStored` 仅作 reconcile/spool
的“疑似重复”信号（`suspected: true`），不得把新 turn 判为已写。
**消息长度（R2 P1-D）**：单条 ≤8192 码点（官方 v3-api），超限回合跳过并记录
结构化 reason（不悄悄截断）；`readScenario({path})`、`listScenarios({path_prefix})`
与官方 SDK 逐字段一致。

无 server-side idempotency 时，本实现为**客户端最佳努力幂等**（client best-effort
idempotency），不宣称全局 exactly-once。

| 状态 | 含义 | 迁移 |
| --- | --- | --- |
| pending | 未发送或发送前失败（连接拒绝等） | 可重试 |
| sending | 请求已发出 | — |
| acknowledged | 服务端 ACK，或写前读回发现已存在 | 终态，重复 execute → duplicate |
| unknown | 请求可能已到达但响应未知（超时/断连） | **不自动重试**；仅 reconcile() 读回对账 |

持久化：`runtime/state/turns.json`（原子替换，上限 5000 条 FIFO）。
进程重启后 acknowledged/unknown 依然生效（E2E C2 实测）。

**已知限制（服务端）**：Core v3 `POST /v3/conversation/add` 无 `idempotency_key`
参数（官方 SDK `V3ConversationAddRequest` 亦无）。exactly-once 目前依仗
"本地持久化 + 写前读回 + unknown 不重试"三重客户端机制；极端场景（状态文件丢失且
服务端已有数据）仍需一次读回校验兜底。**未对生产 schema 做任何变更。**

## 5. 对上游的可选提案（不改生产）

建议 Core v3 增加可选幂等键（向后兼容）：

```http
POST /v3/conversation/add
{
  "session_id": "opencode-abc…",
  "messages": [ { "role": "user", "content": "…" }, … ],
  "idempotency_key": "<turnKey = SHA256(service,team,user,agent,client,session,turn)>"
}
```

- 语义：同一 `(team_id, agent_id, session_id, idempotency_key)` 重复提交返回首次结果
  （`duplicate: true`），不产生新 L0 记录；
- store 层：`conversation` 表加唯一索引 `(team_id, agent_id, session_id, idempotency_key)`；
  迁移为幂等 DDL（`CREATE UNIQUE INDEX IF NOT EXISTS`），旧数据 `idempotency_key` 为 NULL
  不冲突（唯一索引对 NULL 多值放行，需按后端语义确认或补默认值列）；
- 客户端侧可保持现有实现不变，仅在新版本 Core 可用后开启直传。
- 该提案需要上游评审与迁移审批，**本里程碑不实施**。

## 6. 权限模型与生产加固方案（Hard Gate）

**M0 实测发现（P0）**：Gateway 仅"可选服务级 Bearer"，本部署未启用（legacy 兼容值，
`auth=disabled host=0.0.0.0`）；身份四元组来自请求 body/header 且**不与凭据绑定**——
错误/缺失 user-key 均可读取真实记忆数据（实测 `code 0`）。

本里程碑的缓解（已实施）：
- 客户端侧 `identity.mjs`：授权作用域 allowlist + fail-closed，越权配置拒绝 recall/capture；
- 所有客户端只持同一个服务级 Bearer，无业务密钥分发到客户端。

生产启用前的部署侧方案（**只写方案，未执行**）：
1. Gateway 绑 `127.0.0.1`（或设强 `TDAI_GATEWAY_API_KEY`），消除 0.0.0.0 暴露；
2. 上游侧：Gateway 将 `x-tdai-user-key` 绑定 user_id 并校验 team/agent 归属，
   拒绝 body 伪造身份（对应官方 Issue #1631 评论 D 项）；
3. 可选：受控本机 memory bridge（仅代理 Core 控制调用，不代理 LLM）集中持 key；
4. 回滚：恢复原 `.env`/`tdai-gateway.yaml` 与容器配置即可（本分支未改生产配置）。

## 7. 与官方 Proxy 路径的关系

| | 官方 Proxy 适配 | 本实现（Hook/Plugin 直连） |
| --- | --- | --- |
| 模型耦合 | 必须切换模型（代理上游单一固定） | 无关，任意 provider |
| 注入 | 服务端 injector 管线（skill/knowledge/tdai-memory） | 客户端注入（system prompt / additionalContext） |
| session-init | 服务端向导 + header 预选 | 配置五元组 + allowlist |
| L0 写入 | 代理写入 | Hook/Plugin 写入（每轮一次） |
| 双路径 | 插件/ hook 检测 proxy provider 自动静默 | 同左 |

两者可并存：共享同一 Core 记忆块，互不双写。
