# GPT-AM-R3-R1｜R3 独立审查收口：鉴权 fail-closed、真实 RED、持久 ACK、scoped 身份隔离证据

**状态：隔离修复指令（不构成任何生产操作授权）。**
基线：`feat/gpt-am-r3-security-readiness@aa9d67e23f96e54d685aa0de5ac6309998461dfa`，报告 `docs/agent-memory/ZCODE-AM-R3.md`。R3 当前 Verdict `PASS_WITH_ARCH_GATES`；独立复核发现更高优先级 P0/P1，不能据此直接升级生产。SEC-001/002 的 Core8420/Hub8125/Knowledge8424/Proxy8096 loopback-only 和 Mac 现有镜像、数据、Hooks 是保护边界。

## 一、大里程碑执行纪律

只在**独占隔离 worktree**创建 `feat/gpt-am-r3-r1-review-closeout`（基于 R3 SHA），一次连续执行 TDD RED→修复→L1/L2→严格 L3 隔离 E2E→文档→commit→push→报告→STOP。无需子任务逐项请示。

**严禁**改动/重启/重建现有 Mac 生产 Core/Proxy/Hub、生产密钥/数据卷/真实 L0-L3/Hook 配置、开启强 Bearer、合并 PR、修改官方 Issue。M4 服务端 scoped auth 仍是架构 Hard Gate，本轮可以做隔离威胁模型/RED 证据/方案，不得未经授权修改既有 Gateway 授权语义或生产部署。

## 二、独立复核确认的风险及精确代码面

### P0-A｜Proxy 配置缺失意外关闭鉴权（优先）

`MemoryProxy/src/auth.ts:initAuth` 在 `cfg.enabled=true` 且 `!cfg.serviceBearer` 时只 `log.warn` 然后 `return`。初始化时模块级 `config` 为 `null`，后续 `verifyUserKey` 的 `if (!config) return {userId:"",rejected:false}` 于是**接受原本应该被拒绝的请求**。若原先 config 曾初始化成功，再次调用缺 key 的 initAuth 还可能保留旧配置。已有 `!cfg.url` 也会把启用鉴权变为 passthrough，属于同类问题。**目前仅做隔离修复，不要在公开 Issue 附复现真实生产密钥/用户。**

**决定性 RED**：
1. `enabled:true, url:valid, serviceBearer:""` 走 `stageAuth`：必须 `rejected:true`，并且不能进入模型 upstream，也不能 fallback userId/keyId；
2. `enabled:true, url:""` 同样拒绝；`serviceBearer` 缺失但 Gateway 本地仍开放时也必须拒绝（不是只在 Core 强 Bearer 情况拒绝）；
3. 已配置正常→错误重初始化→立即拒绝，不能继承旧 token；错误配置→恢复正常→正常用户可用；
4. `enabled:false` 只有**显式**关闭才允许旧版 passthrough，同时警告清楚；缺属性/解析错误不能等价于关闭；启用但校验网络故障/401/500/错误 envelope 均拒绝；
5. `isAuthEnabled` 与各 callers 不得把配置失败的状态解释为关闭鉴权；原 OpenAI/Anthropic/Codex/Workbench 路径均覆盖。

**推荐实施**：`AuthRuntimeState= {mode:"disabled"} | {mode:"enabled",config} | {mode:"misconfigured",reason}`（或者等价的不可绕过状态）；`initAuth` 每次无条件覆盖 state，在 `enabled:true` 配置缺失时设 `misconfigured`。校验入口对非 disabled 的任何错误立即 `rejected:true`，不能只 log WARN 之后 `return`。兼容现有 `config.yaml` 时要明确 `auth.enabled` 缺省语义和服务凭据来源，不新增不透明 fallback；生产迁移检查独立记录。

修改面：`MemoryProxy/src/auth.ts`、`src/config.ts`、`src/types.ts`、`src/pipeline/stages/auth.ts`（若需）；新单元测试+HTTP 合成全栈负例。

### P0-B｜R3 一键 E2E “能打印”≠“可复现且自动判定”

`ops/e2e/run-r3-security-e2e.sh` 用 `git -C "$REPO" show "HEAD:MemoryProxy/src/auth.ts"` 构造 RED；但当前 R3 HEAD **已经包含 Bearer 修复**：重跑 RED 将引用修复后文件，导致 `grep serviceBearer` 保护失败。当前脚本可能是在提交前 HEAD 指旧版时成功过，报告不等于当前 SHA 的可重现证据。

`ops/e2e/proxy-bearer-e2e.mjs` 对 `docker rm -f $TAG` 使用必成功 `sh`，目标容器不存在时可能直接抛错；最终不比较任何 expected status，而是无条件 `process.exit(0)`。外层 `rg '"httpStatus"|...' `只匹配**字段名**，并未判断正确的 401/200/上游成功；即使逻辑回归也可能假绿。`scoped-identity-probe.mjs` 也仅打印五类 allowed，没有按预期安全阶段判定。

**RED/GREEN 规范**：
- 以明确固定的未修复基线 `44f7b977de86e9fe17f60b174ee7a57b92ba6b81:MemoryProxy/src/auth.ts` 构建 RED，或通过测试注入构造已知无 Bearer 的调用。不能依赖移动 `HEAD`。
- 检查隔离 test resource 的名称/标记，`docker rm -f` 目标不存在应正常处理；若存在**非本任务**同名容器则 fail，绝不能删未知容器。cleanup 在任意失败（包括 JS fetch 异常）都应保留关键脱敏诊断并清理自有临时资源。
- 断言 RED 强 Bearer → 401 & upstream 未达；GREEN 合法 service Bearer + userKey → 200 & upstreamReached true；错 Bearer、缺/错 userKey → 各自明确拒绝；并增加 **P0-A 缺 serviceBearer、缺 auth.url 两个场景**。不要只用 `rg` 匹配输出。
- 独立进程、隔离镜像/source fingerprint、随机可管理宿主测试端口、固定/仅 isolated volume、测试退出码必须反映实际断言，不依赖 6s sleep 偶然时序。
- `npm test` 和 `node --test` 为 CODE/HTTP 负例；`run-r3-security-e2e.sh` 从**已提交、干净的 worktree**单条命令即可重跑成功。

### P1-C｜`reconcile()` 与 spool 的“疑似 ACK”语义仍冲突

`integrations/agent-memory/src/dedupe.mjs:reconcile` 的 `verify({key})` 为 true 时依然 `#set(key,"acknowledged",{via:"reconcile-suspected"})`，即便注释已承认内容匹配只属 suspected。这与 R3 的 `retryQueuedCaptures` 中 unknown 仅报告 suspected、不升级不出队相矛盾。先查全部实际 caller，再补 RED：不同 turnKey、相同会话文本、第一轮 ACK/第二轮 unknown，执行任何 reconcile 调用不得把第二轮升级 ACK；需要有唯一服务端 receipt/经验证的同 key 幂等记录才能 durable ACK。未实现服务端 idempotency_key 时保持 unknown+suspected，且不得误删 spool。不要仅修 spool 忽略 reconcile。

### P1-D｜spool retry 缺少发送锁/ACK 持久化闭环

`capture.mjs:retryQueuedCaptures` 直接调用 `coreClient.addConversation`，绕过 `TurnDedupe.execute` 的回合锁和发送前持久 `sending`。重发成功后 `markAcknowledged` 忽略 `#set` 持久化返回值，回调直接 `return true` 并出队；即使状态盘写失败，后续崩溃可能失去准确交付状态。`dedupe.execute` 也在 ACK `#set` 失败后返回 acknowledged，未区分 ACK 真实收到与 ACK 已持久化。

强默认：
- retry 复用同一**跨进程 key 锁和状态转移**；`retryable` 可从**已持久 definitely_not_sent**状态重试，进入网络前 durable sending 成功，否则 deferred；unknown/sending 绝不重发；
- 收到服务端成功响应但磁盘 ACK 无法写入时，保留**durable uncertain/sending**证据并禁止自动出队盲重试；绝对不能把内存态称作 durable ACK；具体记录策略可按现有 crash-recovery (sending→unknown) 构造。
- 测两个重试消费者竞争单一 key、收到 ACK 后磁盘只读/ENOSPC、ACK 前 kill/restart、同内容不同 turn、状态文件 corrupt，各项确保 no-blind-double-send/不误出队。

`state-store.mjs:normalizeCapture` 使用 `digest=sha256({memorySessionId,messages})`，即使已保留 turnKey，队列 consolidate 的已知记录去重仍主要基于 digest。需要核实两个**不同 turnKey、完全相同消息及 timestamp**的队列不会合并；能提供 turnKey 时，队列主身份应当是 turnKey，而非内容摘要；旧无 key 时保持 quarantine/人工核验。这点必须有决定性 RED。

## 三、M4 scoped authorization：更真实的隔离证据，不擅自修架构

R3 报告 S1/S2/S3/S4 大多是伪造不存在的 team/agent/user id，HTTP 200 + 空结果可证明 API 缺少拒绝门，但不能充当“已确认读出他人真实资料”的完整证明。S5 合成伪造写入并落盘更强。请在**全新隔离 Core 数据卷**建立真实合成：
- 两个互不互属的 user A/B，team A/B、agent A/B、以及 seeded 仅 B 可见的合成 L0；
- 用合成恶意调用测试无 user-key、A 冒充 B、跨非成员 team、未授权 agent 的读/写；区分 `200 + 空数据`、`200 + B 数据命中`、`403/404`、元数据已有 ACL 拒绝；
- 精确标明每条请求的真实（合成）用户、member/agent binding、写后实际落盘证据和边界所属模块；不输出真实生产内容或密钥。

架构提案形成 `docs/agent-memory/SCOPED-AUTH-DESIGN.md`：服务 Bearer 身份与 user-key 身份分离，Core v3 server-side principal 的建立/metadata team membership/agent binding/ACL，v2/bridge/内部任务/后台 Pipeline 的同步 bypass 防御，服务间 admin 权限最小化；列 API/配置契约、伪 diff、deny-by-default、升级路径、单机兼容/多租户风险、测试矩阵。**涉及新凭据分发、强制改变原 metadata ACL、数据库迁移、必须改生产业务时 STOP 于架构 Hard Gate**，不要以临时适配覆盖安全设计。

同时校订 `docs/agent-memory/PROD-AUTH-ROLLOUT.md`：
- 不可把“清空 Core Bearer”列为可无审批自动回退动作；安全配置回退只能在授权的明确风险边界内，功能故障时优先 fail closed；
- `auth.enabled` 缺配置必须 fail-closed、强 Gateway auth 只是第一层，并不自动意味着 user/team scoped 防护有效；
- 不做全局共享服务 key 的越权系统用户假设；真实部署身份维度要经过服务器端校验；
- 生产仍 loopback-only，正式升级必须另外明确授权。

## 四、综合验收门

1. 运行 `integrations/agent-memory` 全部测试、真实隔离 HTTP/Host E2E、docker guard mock 11+ cases，并增 P0-A 负例与 P1-C/D crash/concurrency 测试；所有失败路径均不能将安全降级为“继续放行”。
2. TDD 记录每个缺陷修复前确实 RED、修复后 GREEN；不能用注释/模拟断言替代被测生产代码路径；提交后**再在干净 checkout 从 HEAD 重跑 E2E**，不能只用提交前的红绿记录。
3. 用代码实证而非仅凭测试计数说明哪部分已达到 production-compatible 和哪些仍被 scoped authorization 阻断。
4. 产出 `docs/agent-memory/ZCODE-AM-R3-R1.md`、`SCOPED-AUTH-DESIGN.md`、更新 `TEST-EVIDENCE.md`、`PROD-AUTH-ROLLOUT.md`；给 diff/commit/head SHA/实际 `npm test` 总数/退出码/合成 HTTP status/cleanup、剩余被阻断项。
5. 只在本人 Fork 分支 `feat/gpt-am-r3-r1-review-closeout` push，**不自动建上游 PR/不自动 merge/不碰生产**；结论 `PASS_WITH_ARCH_GATE`/ `FAIL`。Service-level auth 代码即便绿也不能称 user scoped auth 已关闭。
6. 若确需升级 Architecture/spec 以解决 M4，提交完整方案并**只停一次**到用户下一正式架构/生产授权门。不得以用户之前端口收敛的批准推定启用强鉴权的授权。
