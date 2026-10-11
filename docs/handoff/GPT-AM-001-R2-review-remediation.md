# GPT-AM-001-R2｜Agent Memory 独立复核收口（仅隔离修复，禁止生产切换）

**这是 GPT-AM-001 的 R2 收口指令，不是另起项目。** 从已提交实施分支 `feat/gpt-am-001-agent-memory`、报告 HEAD `89ca160d15f724e03673bf84293966fa222224da` 开始核实。参考 ZCODE-AM-001、M0-baseline、ARCHITECTURE、TEST-EVIDENCE；本指令基于对真正源码的独立审查。

**工作目标**：在原实施基础上关闭影响正确性/安全性的契约缺陷；一个里程碑连续做到 TDD→修复→回归→隔离 E2E→文档→commit→push→回写，**仅真正 Hard Gate 停**。不改 macos-memory staged 副本、不替换线上 Hooks、插件、不重启线上 Core/Proxy/Hub、不更改生产 .env/config、不修改真实 L0、不提交官方 PR、不 merge。

## 0. 无条件 RED pins（修复前必须确实失败）

以下每个问题已经定位到源码，但应先通过可重复测试证明。现有 18 套/124 断言、当前报告 `PASS_WITH_IMPLEMENTATION_GATES` 不可当作这几个风险的 GREEN。

### P0-A: 实际 CoreTransportError 丢失写入送达状态

- `integrations/agent-memory/src/core-client.mjs`: `CoreTransportError` 仅持有 `cause`，`#post()` 的 fetch abort/disconnect/HTTP 解析异常都没赋 `afterSend`。
- `src/dedupe.mjs:execute()`: `const afterSend = error?.afterSend === true`，否则归类 pending/retryable。
- `src/capture.mjs:retryQueuedCaptures()` 与 `src/hook-cli.mjs:stop()` 可能随后重发。
- **RED**：模拟 Core 服务端已提交一组 L0，响应头/响应体前 TCP 断开或超时；真实 CoreClient 产生的错误通过 capture→dedupe→spool，不得进入“肯定未送达，可自动重试”。重复消费不能写第二组。另测 preflight 失败（请求完全未送达）可重试、HTTP 授权拒绝不可重试。
- **强默认方案**：引入判别联合错误 `delivery: 'definitely_not_sent'|'maybe_sent'|'rejected'`（具体命名可按风格），`maybe_sent` → 持久化 unknown；只有可证明请求未开始才 retryable；核心区别是“请求已经发出但没有收到 ACK”应保守判 unknown，不依赖不存在的 `afterSend`。不要把鉴权 401/403 当网络失败，不允许私自退到 default 身份。
- 无 server-side idempotency，不能宣称全局 exactly-once；未知送达允许读回辅助排查，但不能仅按文本相同判定相同 turn。

### P0-B: 跨进程锁失效仍放行写入

- `src/dedupe.mjs:#acquireLock` 竞争 1500ms 后返回 null；`execute` 在 null 情况下依旧 `verify()→send()`。
- 文件系统错误也返回 null 并继续；stale 10s 强行删除锁未确认 holder 已死亡；锁后 state 文件合并读回，没有严格持久化异常处理。
- **RED**：持锁进程超过 1500ms，第二进程不可并发发写请求；锁目录不可创建/被占用/IO 错误也不得绕过互斥；杀进程或 stale 锁场景可以有界恢复但不能破坏在途 writer；N 进程长延迟/慢 Core 下无双写。
- **强默认方案**：锁获取失败返回 `deferred` / `unknown`，只影响记忆捕获，不阻塞 Agent 主流程；持久化 `sending` 进程崩溃后不得无条件重发，应按 `unknown` 对账；只有持锁者可释放对应锁（owner token/lease，过期回收需确认互斥安全）。禁止“拿不到锁就依赖读回碰运气”。

### P1-C: 状态持久化失败被静默吞掉

- `src/dedupe.mjs:#persist` 捕获异常空操作，`#set` 随后返回，可能把无法持久化的 ACK / unknown 当作稳定状态；`turns.json` 仅按 FIFO 截取最后 5000 条。
- **RED**：磁盘只读/满、临时文件原子替换失败、状态文件损坏、进程 kill、跨进程同时使用不同 key。不得把“当前进程 Map 有状态”当作“重启后已保障”。
- **建议**：将 durable 保证与结果分离；持久化失败警报、显式 degraded 状态；不得在不安全时重新发送；需确保不同 key 并发状态更新不因最后写覆盖（全局状态写锁/逐 turn 文件/SQLite 选一）。持久日志与 spool 只写最少敏感内容，目录 0700、文件 0600，权限与损坏恢复可测。
- 若跨文件系统锁/写无法提供正确性，调整为单 writer memory bridge/spool 服务，作为可验证最小替代；不得未经批准启用生产常驻服务。

### P1-D: 真正的 Core v3 SDK 契约不匹配

- `src/core-client.mjs:readScenario({name})` 发送 `{scenario:name}`；官方 `sdk/memory-core/typescript/src/v3/client.ts:readScenario({path})` 发送 `{path:...}`。
- `src/core-client.mjs:listScenarios` 误把 sessionId 用作 ls 查询参数，正式契约是 `path_prefix`。
- 官方 `MemoryCore/v3-api-memorycore-doc.md` 指明 `/v3/conversation/add` 单条消息 1–8192 字符；`src/capture.mjs` 却以 30000/60000 作为限制。注意 UTF-8/字符统计、长文本 chunking 与回合意义。
- **RED**：对照官方真实 SDK 参数校验 `readScenario(path)`、`listScenarios(path_prefix)`、超限 user/assistant、非 ASCII；使用隔离真实 Core，确保不会出现 JSON 层面通过、服务端拒绝、spool 一直重试的死循环。
- **建议**：优先实际复用官方 SDK 或使用从其契约提取的显式对照测试。长文本方案：可设计安全可追溯、明确展示降级的概要/分块协议，但不得悄悄截断语义或泄漏隐私；若用户文本无法符合 Core 限制，则跳过捕获+记录结构化 reason，并保持 Agent 正常。

### P1-E: 文本匹配读回误判“已经完成这个 turn”

- `src/capture.mjs:alreadyStored` 只在一个 session 查最新20条，再按 role/content 匹配 user/assistant；不同 turn 如问题和答复完全相同，会被当作同一回合，漏记真实历史。也无法证明哪个 turn 已 ACK。
- `#persist` 截止5000、重启、文件清理后更可能遇到此类冲突。
- **RED**：同 session 内两次真实相同 user+assistant、不同 turnId → 必须保存两组；同 turn 重复送达 → 不新增。20条分页边界/远端 ACK 丢失也必须给出可核实语义。
- **建议**：turnKey 持久化状态是客户端主要依据；服务端支持幂等键之前，内容匹配只能提供“疑似重复”信息，不能无条件转 acknowledged；对于 unknown 保持需人工/服务端 key 对账。若要更严格，先在隔离 Core 分支实现可选 idempotency_key 的兼容设计并对两种后端测试；不做未经批准的生产 DB migration。

## 1. P0-F: 服务端身份鉴权缺口单独留为上线 Hard Gate

- `M0-baseline.md` 已证实当前 Gateway `0.0.0.0 + auth disabled`，并实测错误/缺失 user-key 可依靠伪造请求中的 user/team/agent 身份读取和写入。
- **不批准线上切换，不改变现网 bind/key**。在隔离环境重新构造 unauthorized read/write 测试；形成安全上线预案：
  - **Gateway 同时** loopback-only + 强随机 Bearer，明确 Docker host-port 暴露及其他容器访问路径，不要把“只设其中一个”当作普遍安全充分条件；
  - 现有 Hub/Proxy/Core 互访要求逐一审计；不能因为绑 loopback 就把 Docker 内部连接断开；
  - API Gateway Bearer ≠ 普通 user_key，Team/User/Agent body IDs 并不自动证明 ACL；
  - 单用户受信主机场景与多用户共享部署分别定义威胁模型；多用户则需 server-side user-key→user_id→team/agent authorization 或受控 scoped memory broker（仅记忆控制流，不转发 LLM），非法身份 403/404 且不给出数据；严禁对未授权信息使用不安全降级。
- 写出脱敏风险路径、最小变更面、Docker网络图、逐层真实健康检查、按顺序恢复策略、变更窗口、回滚演练脚本（**只在隔离环境执行**）。
- 若发现当前端口对非受信主机实际可达或密钥明文外泄，**立即 STOP 并报告应急处置建议**，不擅自改动生产。
- 官方 Issue #1631 当前评论数应按 API 真值核对，不把文档里所谓“评论 D 项”当作确有该评论。

## 2. 测试证据一致性及真实兼容边界

- `TEST-EVIDENCE.md` 曾保留“3进程并发最多2条”旧数据；`ZCODE-AM-001.md` 写“4进程恰好1次”。必须使用同一确定性测试的原始日志/commit/测试参数，写清楚历史缺陷与修复后结果，不能把“报告修订”当作修复事实。
- Gate A 实际主要是 Codex Hook + OpenCode plugin 线路的隔离测试，不能推广为四个真实客户端的全模式端到端验收。增加 Claude / ZCode 的真实 hook JSON 模拟和安装目录只读检查；如不连接真实客户端，诚实说明缺什么证据。
- OpenCode 1.18.35 TUI 与 `opencode run` 行为不同；`run` 模式回合捕获缺口，应有可选的支持方案/准确检测，不伪称已解决；2.x 不能声称已覆盖。
- 依赖远端 Core 的 E2E 应固定可复现镜像 digest 或版本，不只依赖 `:latest`；隔离数据/容器资源自动清理，失败时同样清理；不要在隔离测试日志打印生产密钥或真实 L0。
- 单元 RED→GREEN + L2 回归 + 隔离 E2E 必须逐条对应以上 A–F；额外注入异常：HTTP partial-body、响应头收后断线、超时、Core 确认已持久化但客户端没收到 ACK、磁盘满、锁跨进程超时、ACK 后进程 kill。

## 3. 实施顺序与具体变更面

- 从本人 Fork 当前 `feat/gpt-am-001-agent-memory` 最新 commit 建隔离工作树 + 修复分支 `feat/gpt-am-001-r2-safety`；先记录 SHA/dirty 状态。
- 先 RED pins → `src/core-client.mjs` 分类异常与调用边界 → `src/dedupe.mjs` 锁/崩溃/持久化状态机 → `src/capture.mjs` 幂等与长度/队列 → `src/state-store.mjs` durable spool → `src/hook-cli.mjs` 与 `plugin/opencode-cross-agent-memory.js` 接线 → 全部测试。
- 推荐状态机：
```
created/pending --durable--> sending --ACK--> acknowledged
          |                    |
      definitely_not_sent      +-- ambiguous transport/timeout/crash --> unknown
          |                                                    |
       retryable                                    reconciliation only
lock unavailable / persistence broken => deferred/disabled capture; Agent continues
authorization invalid => denied, never default or retry
```
- 尽可能沿用已有文件/导出，不为修复小问题重构整套项目；保证旧生产版完全不触碰。
- 对用户隐私的任何保留队列实施本地访问权限保护，添加结构化 metrics（不泄露明文）。
- 严格按实际 blast radius 跑 L1/L2，隔离 release candidate 运行全量 L3；报告测试断言数、日志/产物哈希、镜像版本、实验前后 L0 数量，不只写“通过”。

## 4. 交付、权限、终止条件

**交付文件**（修复分支）：
- `docs/agent-memory/ZCODE-AM-001-R2.md`：逐问题 Root Cause、RED/GREEN pin、修复文件/关键函数、真实命令与结果、风险、正式 Gate；
- 更新 ARCHITECTURE、TEST-EVIDENCE，并注明旧报告与修复后数据差异；
- `docs/agent-memory/PRODUCTION-SECURITY-PLAN.md`：Core/Hub/Proxy 内外网络权限与 staged security rollout，明确非生产执行；
- 若需要 schema migration，先提供 draft + 回滚策略，不应用现网。
- 本人的功能分支 commit/push，**不 merge，不改默认分支，不公开发上游 PR，不启用生产**。
- R2 达成条件是上述 correctness 问题真正关闭、与官方 Core SDK 合约一致、测试有独立复现结果；若 server-side exactly-once 未实现，报告只能称“client best-effort idempotency”，不得宣称全局 exactly-once。
- 唯一下一 Hard Gate 为**生产 Gateway 安全加固 + 灰度接入审批**。出现未知凭据权限、生产暴露、不可逆迁移、需要改变冻结方案时直接 STOP 并报告建议，勿先实施。

**ZCode 完成后把修复分支及 `ZCODE-AM-001-R2.md` 的链接发回。**
