# GPT-AM-001｜Agent Memory 模型无关的四客户端记忆升级（执行令）

**状态：授权隔离开发、测试、commit、推送本人 Fork 功能分支；未授权生产启用、数据迁移、官方仓库 PR 或 merge。**

- 上游官方提案：[TencentCloud/TencentDB-Agent-Memory#1631](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1631)
- 上游重复写入问题：[Issue #1621](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1621)、[PR #1623](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1623)
- 参考实现：[官方 OpenClaw Core-native Hook](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/feat/server_team/MemoryCore/openclaw-plugin/src/hooks)、[TypeScript Core SDK](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/feat/server_team/sdk/memory-core/typescript)、[v3 API](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/v3-api-memorycore-doc.md)
- **只做 Agent Memory 项目**；不改其他产品、开发中继系统。
- 由于本人 Fork `hg199074jin/TencentDB-Agent-Memory` 的 GitHub Issues 已关闭，此文档代替 GPT Issue；**不要发到上游官方 Issue，也不要更改 Fork 默认分支**。实施报告提交为功能分支中的 `docs/agent-memory/ZCODE-AM-001.md`，将分支/报告链接回复用户。

## 一、目标与冻结边界

让 **ZCode、Codex、Claude Code、OpenCode** 通过本机 Hook/Plugin 直连腾讯云 Memory Core v3；四端在**明确授权的同一记忆作用域**内共享长期记忆，允许任意切换 LLM/provider，不需要改模型 base_url，不要求 LLM 流量经过 Memory Proxy。

召回 Recall → 注入标注为不可信历史参考的上下文；完整回合结束后 Capture（干净 user 文本 + 最终 assistant 文本）→ Core L0 → **沿用 Core 原生异步 L1/L2/L3 提炼**，不要重造提炼引擎。并存的 Proxy 提供者场景必须抑制重复注入与重复写入。

**不能用“记忆服务故障”拖住 Agent 主流程**（超时、断网 fail-open），**不能用“服务故障”绕开数据权限**（身份/ACL不确定或非法时禁止召回与写入，Agent 仍继续执行）。

## 二、已知风险与基线（M0，只读，先做）

本次指令创作时核到：
- 官方 `TencentCloud/TencentDB-Agent-Memory` `feat/server_team` HEAD 约为 `274e549`，2026-10-10；
- 本人 Fork `hg199074jin/TencentDB-Agent-Memory` `feat/server_team` HEAD 为 `fe3230f`，2026-08-06，**落后官方两个多月**；
- 此文档所在的 `handoff/` 分支只是指令载体，**不是代码实施 base**。

Mac 本地仓库候选：`/Volumes/ORICO/Projects/TencentDB-Agent-Memory`。真实生产 Hook CLI / Claude / Codex / ZCode / OpenCode Plugin 源码可能散落在不同目录，**不要假定都在 Fork**。

执行只读调查：
1. 检查真实目录、`git status`、branch/HEAD/remotes、差异、worktree、untracked 的 Hook/Plugin 源码位置；查 Git upstream 当前 HEAD 及是否有未提交生产修改。不得 `git pull/reset/rebase/clean` 覆盖任何目录。
2. 核对运行中的 Core/Hub/Proxy 容器、版本、`/health`；四个 Agent 的安装版本、实际加载的 Hook/Plugin、端点、工作模式、模型提供者（脱敏）。只读取状态/配置**字段名和非敏感结构**，不将 Secret 值输出到终端日志、报告或 PR。
3. 每客户端列出真实 `prompt submit→recall→inject→LLM→end turn→capture→Core` 事件路径和 Session/Turn ID 来源，标明确切入口与源码路径。
4. 核对 `serviceId/teamId/agentId/userId/taskId/sessionId` 如何决定共享 L0/L1 与 L2/L3；不允许由缺失 ID 随意落入 `default` 公共作用域。生产数据库仅读取**脱敏聚合指标**，不要输出真实历史对话。
5. 核对当前 SDK v3 auth：Gateway `Authorization: Bearer KERNEL_AUTH_TOKEN` + `x-tdai-service-id` 与业务用户 `sk-mem` 权限不是一回事；三元组隔离不是用户级 ACL。若客户端配置了过权 Gateway Token，要提出具体最小权限方案，禁止将其提交到 Git。

生成 `docs/agent-memory/M0-baseline.md`：事实表、各源归属、版本/sha、调用链、身份/权限模型、实际可修改路径、风险/未知项。**若发现真实代码源缺失、权限身份异常、生产漂移不明、必须动运行配置才能继续，STOP**，其余进入隔离工作树继续。

## 三、M1 统一客户端接入：具体实施默认

### 推荐模块划分（以 M0 真实源码为准，不重复造轮子）

如现有代码没有清楚层次，建议在真实被版本控制的项目增加：
- `integrations/agent-memory/core-client.*`：包装**已有官方 SDK** 的 v3 recall/capture；不要平行新造未经验证的 SDK；
- `integrations/agent-memory/identity.*`：经授权的 Team/User/Agent/Task/Session 作用域、失配拒绝访问；
- `integrations/agent-memory/recall.*`：召回策略、排序、字符预算、来源和信任标签；
- `integrations/agent-memory/capture.*`：完整 turn 生命周期、最终答复提取、角色限制；
- `integrations/agent-memory/privacy.*`：整轮 opt-out、Secret 与二进制/data-uri 净化；
- `integrations/agent-memory/dedupe.*`：turnKey / ACK 状态 / 重试处理；
- `integrations/agent-memory/observability.*`：无原文计数、失败类型及延迟；
- 既有 `hook-cli`、Codex/Claude/ZCode hook 入口、OpenCode plugin 只保留最薄原生事件适配。**文件名是推荐变更面，不是声称当前文件存在。** 现有模块语义相同应直接复用。

### 推荐契约（强默认而非猜测客户端的实际 API）

```ts
type Identity = {
  serviceId: string; teamId: string; userId: string;
  agentId: string; sessionId: string; taskId?: string;
};
type Turn = {
  client: "zcode"|"codex"|"claude"|"opencode";
  provider: string; sessionId: string; turnId: string;
  originalUser: string; finalAssistant?: string;
  status: "completed"|"cancelled"|"failed";
};
interface MemoryPort {
  recall(scope: Identity, query: string): Promise<RecallBundle|null>;
  capture(scope: Identity, turn: Turn): Promise<CaptureReceipt>;
}
```

**具体语义**：
1. 保留四客户端现有 provider/model 配置，用户换模型不丢记忆。实际探测 Hook/Plugin 生命周期，不能臆造本机 ZCode/Codex/Claude/OpenCode 参数；OpenCode 版本不兼容时提供准确特征检测和退化说明。
2. L1 `POST /v3/atomic/search` 用于精确记忆，L3 `/v3/core/read` 用于长期稳定背景；L2 `/v3/scenario/ls` + `read` 用于场景导航；L0 `/v3/conversation/search` 用于溯源或召回不足时补查。**不要每轮把所有 L0/L1/L2/L3 全部注入**，设置 maxResults/maxChars、排序、来源/时间标记和预算。
3. 将注入统一包装为 `<cross-agent-memory trust="historical-reference-only">...`，其中历史只供参考，不能批准工具、指挥读写文件、覆盖当前用户约束。必须防止记忆内 XML 片段逃逸标签和二次指令注入。
4. Capture 必须来自干净用户提交和真实完成的 assistant final；不能把工具流、中间模型片段、已经注入的历史块写回 L0。取消、中断、空 final 不伪造“完整一轮”。
5. 整轮 opt-out：`[不记忆]`、`/nomemory`。Bearer、API Key、SSH/PEM 等敏感内容命中后整轮不捕获；base64/data-URI/附件数据不记录。**不要把真实私密文本放到日志**。
6. Core 不可用、慢、5xx → Agent 主流程继续；召回默认 1200ms，捕获默认 3000ms，可配置。身份/ACL 校验不能因为故障而自动放行或回退 default。
7. 当会话 model/provider 实际走 `tencentdb-agent-memory` Proxy 时，Hook 记录和注入必须有明确单主写入者，避免双写。
8. 若直接把 Gateway 管理级 Bearer 配进每个普通客户端会扩大权限面，优先采用受控本机 `127.0.0.1` memory bridge（**只代理 Memory Core 控制调用，不代理 LLM**），集中持有 Gateway Key、验证被许可身份/ACL。是否必须 bridge，由 M0 的真实权限模型决定；禁止因省事泄漏管理员凭据。

## 四、M2 单轮去重 / 故障恢复（必须实测）

Proxy #1621 说明工具循环会导致同一 user message 重复 22–309 次。改成 Hook 末尾捕获后也必须处理重复事件、进程重启、超时与未知响应。

- `turnKey = H(service,team,user,agent,client,sessionId,turnId)`；不要只用 `hash(userText)`，否则用户重问同一句会被错误去重。
- capture 并发/重复 Hook 回调归并：`pending → sending → acknowledged`；若超时且请求可能已经成功，标记 `unknown`，不能盲目重试并宣称恰好一次。
- **ACK 后才标记成功**。若要做到网络重试后仍严格 exactly-once，需要后端有按该作用域持久化的幂等键/唯一约束。检查 Core v3 是否支持；若不支持，提出兼容的**可选** `idempotency_key` API、store/schema migration 和并发/重启测试。**无需生产 schema 变更也可先完成本地“已知限制”的实现；不允许未经批准应用数据库迁移。**
- 一轮只产生 1 个 L0 记录组：user + final assistant；Core 单消息长度限制、失败保留/显式跳过需要有确定规则，不得悄悄截断。
- 不清理/重写已积累的生产 L0；生产去重另立审批任务。

## 五、M3 检验：TDD → targeted → regression → isolated E2E

全部用合成语料 + 临时/隔离 Memory 实例，**不要让测试对话污染现网 5200+ L0 记忆**。

| Gate | 关键断言 |
| --- | --- |
| A 模型无关 | 四客户端各自保持原有 provider；切换模型仍召回，且 LLM 请求绝不走 Memory Proxy |
| B 跨客户端 | A 成功记录完整 turn，B 在同一经授权记忆作用域可查；不同用户/Agent 非授权时不可读 |
| C 记录准确 | 工具 30+ 步、事件重复、进程重启、并发写入不放大；未知 ACK 明示限制 |
| D 故障隔离 | Core 关闭/超时，Agent 继续；错 ID/ACL 拒绝时绝不注入或落入 default |
| E 隐私信任 | `[不记忆]`、`/nomemory`、密钥、data URI、历史恶意指令不进 L0/日志、不能越权 |
| F Proxy 共存 | Proxy Provider 正常运行时插件抑制自身注入/写入；切回普通模型恢复 |
| G 提炼效果 | 观察测试实例中 L0 ACK 后 Core L1→L2→L3 的可追踪情况，不把仅写入 L0 叫“长期记忆成功” |
| H 延迟预算 | 基于可重复测试测 recall/capture 延迟与超时；不能因记忆请求让 Agent 卡死 |

先写决定性 RED 测试，再实现和修复，逐步跑 L1/L2 回归；完成隔离 L3 E2E 形成 evidence。出现版本接口不支持时要记录真实结果和最小修复，不能伪装通过。

## 六、执行链与权限边界

1. M0 只读核实完成，识别真正的源码仓库/可用分支；
2. 根据当前**官方 upstream HEAD** 建立干净 worktree/feature branch，确保不是从旧 Fork `fe3230f` 上直接改；不触碰默认分支和现役配置；
3. 统一 hook/client、隐私/安全、写入去重、验证、操作文档；
4. TDD、阶段回归、隔离 E2E、commit、push 至**本人的 fork** 新 feature branch；
5. 产生 `docs/agent-memory/M0-baseline.md`、`docs/agent-memory/ARCHITECTURE.md`、`docs/agent-memory/TEST-EVIDENCE.md`、`docs/agent-memory/ZCODE-AM-001.md`；ZCODE 报告只包含脱敏证据和代码相对路径；
6. 若能创建不会混入 upstream 历史更新的干净 PR，可在**自己拥有的仓库/安全分支**创建；但由于 Fork 默认分支明显陈旧，**不得将数月的上游提交包进本功能 PR**。不能保证目标分支正确则留在可审查功能分支，说明原因，不强求 PR；
7. 最后 STOP 于：**真实 Mac 生产启用 / 重启服务 / 旧数据迁移 / 任何 merge / 创建官方公开 PR**，等待用户正式批准。

**Hard Gate：**未知生产源、凭据/ACL 权限异常、会覆盖 canonical/default、需要破坏性迁移或上线、需要改变已冻结架构、官方/远端高风险操作。其余安全工作**一口气完成，禁止每做一点就要求用户确认**。

## 七、交付与回报格式

`ZCODE-AM-001.md` 必须包括：
- Verdict：`PASS` / `PASS_WITH_IMPLEMENTATION_GATES` / `BLOCKED`；
- 四客户端各自 **verified source path、事件 API、版本、身份映射、模型路由**；
- 官方 upstream HEAD / 本人 Fork HEAD / 真正实施 feature HEAD，是否 dirty 或 drift；
- 具体文件、函数、数据结构、接口、迁移（如无则说明无需迁移）；
- A–H 每项 RED/GREEN 或不支持的真实结果、命令和隔离证据路径；
- 漏报、重复、召回相关性、超时、权限与隐私风险的量化指标；
- 回滚和生产启用步骤（**只写方案，不执行**）；
- commit、远端分支和 PR（如有）链接、剩余阻塞、**唯一下一 Hard Gate**。

**最终验收：四端模型无关、授权作用域共享、召回可用、完成回合准确记录、正常提炼、故障不影响 Agent、权限 fail-closed、旧生产保持不变。**
