# GPT-AM-FINAL / ROUND 2 of 2｜独立终验、生产灰度、交付与封版

**这是整个 Agent Memory V1 项目的最后一轮实施里程碑。** 下一次不要再追加 R4/R5/更多 GPT-AM-Review 回合；若发现已在批准架构内的缺陷，一律在 Round 2 内修复并完整重验。只有新增重大未授权权限、不可逆数据迁移、无法安全回退、根本架构冲突、生产身份/环境 drift 等真正 Hard Gate 才能停。

**启动门槛**：Round 1 的 ZCode 报告为 RC_READY，GPT 已做独立安全评审并整理剩余问题，用户明确批准 Round 2 的**生产可逆灰度与 Fork PR 合并**。用户仅传本文件、未说明生产批准时，ZCode **只能完成只读/隔离验收，不得生产操作**。不得把过去 Stage 1/1B 的端口止血授权当作本次发布许可。

Round 2 的基线是 Round 1 报告内固定 commit SHA 和对应 Fork PR（不要猜 branch HEAD）；取源仓库当前真实生产 runtime 规格作为只读对照（Core/Hub/Proxy 镜像 ID/环境键名/启动参数/volumes/网络/临时 staged 编辑以及四端口绑定），不能悄悄把生产环境迁往新的工作树。

## 1｜版本冻结原则：V1 交付，不无限扩需求

正式目标是**用户自己的 Mac 本地四客户端 Agent Memory V1.0**：
1. Codex、Claude Code、ZCode、OpenCode TUI 使用原有 LLM/provider/API 配置，能稳定调用同一经过服务端授权的共享记忆；
2. 召回 → 上下文注入 → 结束回合捕获 → L0 持久存储 → 后台 L1 提炼 → 跨客户端召回闭环可见；
3. Core 开强 Bearer + user-key→userId→team/agent/asset authorization，全四数据层越权拒绝，Proxy auth 失败绝不 fail-open；宿主四端口只本机可达；
4. 断网/超时/重复 Stop/客户端切换/Crash 下“不挡模型，不错误提升 ACK，不跨身份泄露、不盲重试”；
5. 安装和移除每个客户端单独可逆；现有模型配置与用户其他 Hook/Plugin 不被破坏；部署脚本和 guard 已版本化；
6. 有严格的测试证据、生产回滚备份、故障诊断、使用文档与最终 v1.0 tag/release 提议。
除这些之外的新功能（云多租户、OpenCode 未稳定的非交互模式、完整工具追踪、全局 exactly-once/需服务器幂等存储、外网跨设备、自动迁移旧历史、官方上游合并）全部进入 v1.1 backlog，**不得以完美主义阻止 V1 验收**；但不得通过缩小既有承诺来掩盖安全阻断。

## 2｜独立终验：先挑战 RC1，而不是先上线

建立独立 release worktree `feat/gpt-am-final-r2-release`，从 Round1 固定 SHA 创建。不得让开发、审查两个进程同时改同一 worktree。根据报告 + PR 对完整 diff 做一次 adversarial review：
- Core scopedAuth 入口：确认 `server.ts`/v2 router/extra route/legacy path 没有以 body 取代 principal、无数据面绕过、系统服务例外最小范围、404/403 无内容泄露；多租户不作不支持的保证；
- Proxy `auth.enabled=true` 缺 serviceBearer、url、错误格式/重新初始化均 fail-closed，各协议 OpenAI/Anthropic/Claude/Codex/ZCode/WorkBuddy 边界有效；
- spool/dedupe/reconcile/queue 中 turnKey、锁、终态、ACK durable/crash、失败时出队、不同 turn 同内容完全一致；如果 Core 没有 server idem key，未知态不可自动二次发送；
- 配置和启动脚本发布端口强约束、生产 Secrets 文件权限、Docker network scope、数据卷/镜像位置、原 Mac staged 更改是否被覆盖；
- OpenCode TUI 原生事件是否真正捕获 final answer；如 OpenCode run 不支持必须写支持矩阵；
- ModelProxy 当前仅保留既有客户用途，新 Hook 启动后对原模型路径不增加代理。
对新增 P0/P1 原地 RED/GREEN；这轮必须一次性收口，无新 review 任务。所有 P0 和影响数据完整性/身份隔离的 P1 必须关闭才能发布；P2 可带有明确 workaround 的接受清单交付。

## 3｜L3 门禁（必须有自动断言 + 从 clean checkout 可重现）

A. 工程全量：Agent Memory Hooks/Plugin、Core、Proxy、Hub 被改模块的 test/typecheck/build、相关官方 regression、lint/shellcheck/CI、deploy source preflight/runtime mock 11+ 用例。报告记录命令、pass/fail/skip、耗时可选但不得只给“全绿”口述。

B. 隔离全栈：用 Round1 当前源 build 出 Core + Proxy 的版本指纹一致的测试镜像（Hub 如代码没改，可复用锁定 digest）；合成 team/user/agent/asset；强 Bearer 与 scoped auth 同时开启，所有真实业务路径 assert 200；无/错 bearer、无/错 userKey、冒充不同真实用户、非 team 成员、agent 无权、跨 instance/v2 route 绕过均 401/403/404，禁止出现 200 但泄 B 数据。

C. 本地四客户端合成测试：每种 native hook/plugin 有完成 event 的真实格式；四端可连续写 4 个不同 turn，随后每个客户端能检索其他客户端许可共享的记忆，含至少一个 L1 真实离线或隔离生成结果；同 turn 30 次重复 Stop 仅一个捕获，合法重复内容的不同 turn 不丢；2+ 并发进程、断网恢复、ACK 丢失、disk fail/lock fail、禁重复；缺服务端存储回执时不要乱判全局 exactly-once。

D. 生产前只读：`ops/loopback-guard.sh` PASS，实际 Docker volumes/backups、健康/资源指标、current hooks 与 providers 指纹记录；四端口不得有 0.0.0.0 或 IPv6 通配；人工声明生产可逆 rollout 的可停止点。特别区分**独立第二台 LAN 机器验证**与本机 LAN IP 拒绝连接；有条件补一台异机，无条件如实说明并靠 PortBindings/防火墙证据支撑。

E. 每项都写明确 expected/result、自动 assert fail 程序必须返回非零；提交后从冻结 SHA 的干净 checkout 重新运行，不能依赖未提交 staged 文件、临时凭据或某个开发会话状态。

若安全门没过：在本轮内继续修复直到合格；不可安全完成则 **FAIL_BLOCKED/STOP**，而不是伪报 SUCCESS 或强行生产。

## 4｜生产联动部署（仅用户已明确批准，单写者 + 可逆）

在真正操作前执行生产专用预检 `ops/loopback-guard.sh` 和 `verify.sh`；快照容器三件套 image digest、volume IDs、network alias、configs file hashes（key 值脱敏）、UID、restart policy、上游模型、两套现役 Hook/provider 配置；确认没有另一个 ZCode/脚本并发部署；对源数据卷做**可验证、访问受限且可恢复**备份，严禁未批准的 data purge 或 schema migration。绝不把真实内容打印入报告。

启动方案必须经过依赖链实际模拟：
- **预部署**：将 Core/Proxy/Hub 的相同强 service key 注入已批准的安全配置通道，核心 Gateway auth 未开时先在隔离预演，确保 Proxy auth/verify、Hub metadata、knowledge tools、skill 进程与后台管线全部具有 Bearer 与必要的最终用户 key；新 Core scopedAuth 启用后先用合成授权用户在隔离实测；
- **生产可逆切换顺序**：在用户批准的变更窗口内，先安装并验证 Proxy 的 fail-closed patch / serviceBearer 配置以及 Hub Bearer 联动（保持旧 Core 兼容），后原 digest 备份情况下切到**经 R1/R2 自建、带 scoped auth 实现的 Core**，明确配置 Gateway strong Bearer + scopedAuthEnabled=true。若 scopedAuth 切换前任一必须消费者未准备，不切。更改 host publish 时仍必须四端 loopback；不要从有全接口默认脚本启动。真实 Core 镜像因授权/配置修改必要，允许 Round2 批准范围内按固定 digest 切换；禁止 pull 漂移标签；
- **服务健康门**：依次验证 Core /health、无 Bearer 拒绝、正确 bearer + userKey 可读、错误 scope 拒绝、Proxy 真实 auth/sessionInit/LLM 路由、Hub UI/Knowledge/Skill 正常、旧 L0 原数据可读且数量不突变、L1/L2/L3 管线、共享资产权限正常；每步失败立即停止后续操作并维持或回到**最小安全状态**，不通过关闭 auth/开放 LAN“修复”；
- **四端灰度**：OpenCode TUI → Codex → Claude Code → ZCode，一端一端安装/启用，完成每端 (prompt→model原provider→recall→capture→L1) 的实际交互验收；原配置自动备份、打 SHA，必要时单独 uninstall 恢复；任端失败只摘除该端 Hook，不影响其他 Agent 的 provider。确认 Proxy provider 路径不会重复写入；
- **开关与回滚**：任何 Core 权限误配优先阻断数据访问并安全恢复**有鉴权的** RC 运行镜像/配置；如果真正安全回滚不可行，STOP，需用户明确审批风险减弱动作；不可自动清空 `TDAI_GATEWAY_API_KEY`、关闭 scoped auth、放开 LAN；原始数据卷必须完好，不允许清洗历史积累以凑验收。
- **生产环境异常**：遇已有生产 drift、无可校验备份、来源不明密钥/权限、额外活跃写者、数据损坏证据，STOP，不强行部署。安全操作可以按已批准范围连续执行，不每重启一个容器问一次用户。

## 5｜最终验收数据与结束条件

至少以非敏感合成 marker 验证：
1. 4/4 客户端原有 model/provider/baseURL 保持不变，4/4 recall 与 capture，跨端共享至少 4x4 授权读回组合（允许使用已存在 L1 内容，必须有来源可追溯）；
2. 重复 Stop (30 次) 只产生一对 L0；不同 turn 同内容必须作为不同记录；unknown / ACK-crash 不盲重试；
3. 服务端负例 0 次未授权读/写成功；分别测无 bearer、无 user-key、跨真实合成 user/team/agent、撤销 key、legacy/v2 绕过；
4. 3/3 栈容器 healthy，4/4 host 端口 127.0.0.1，仅内网桥可互访，持续健康；无未授权 LAN 暴露；数据卷原始生产 L0 完整；
5. Hub/Proxy 的原有真实用户请求可走通，GLM/用户各自模型用原方案，后台提炼可用；审查服务错误率/日志、无明文 key；
6. 记录 latency（recall p50/p95 与既有预算，capture budget）、spool queue、unknown/rejected、失败注入与清理；没有指标也必须报告测试窗口和限制，不编造数字。
不能对受限模式缺真实证据却输出“全模式已实测”。

## 6｜最终产物（必须在第二轮一次交齐）

- `docs/agent-memory/ZCODE-AM-FINAL-R2.md`：状态 + HEAD/digest + 变更/测试 + 自动可重跑证据 + 生产各阶段时间序列 + 身份授权正反例 + 四端模型不变 + 数据/配置完整性 + 回滚检查 + 支持矩阵；
- `docs/agent-memory/USER-GUIDE-CN.md`：怎么开启/暂停/卸载/切换四客户端、怎么共享/隔离记忆、怎么看状态和排障、敏感信息及模型路由安全说明、可接受限制；
- `docs/agent-memory/RELEASE-NOTES-v1.0.md`、`CHANGELOG.md`、`ARCHITECTURE.md`、`TEST-EVIDENCE.md`、`PROD-DEPLOY-RUNBOOK.md` 与 Git commit/PR/CI；必要时规范 package version；
- **Fork 内的** PR 在用户批准的 merge 范围内合并到当前项目 canonical 分支；创建 annotated `v1.0.0` tag 或正式 release（仅在授权包含远端变更时）；两轮 handoff/report 归档。不要未经用户批准修改腾讯云上游 Issue #1631 或 PR。
- 没有生产上线授权，就只可提交 `RC_VERIFIED_AWAITING_PROD_GATE`，不可写 `PRODUCTION_DONE`。有授权且上述 6 大条件实际通过，Verdict = **`PRODUCTION_DONE_V1.0`**，明确宣布两轮项目完成，不再生成下一实施里程碑；未通过且存在不可越过 Hard Gate，只能 `BLOCKED_WITH_EVIDENCE`，不伪称完成。

## 7｜Hard Gate 与用户交互（严格限制在必要门）

**Round 1 报告完成后，需要用户一次正式批准 Round 2 的两类不可逆/生产权限：** (i) 合并本 Fork PR/发布 release/tag；(ii) 在已知风险边界内变更生产 Core/Proxy/Hub 镜像、service key、scoped auth 和四客户端 Hooks。批准文案须列出 exact commit SHA、镜像 digest、备份位置、潜在短暂不可用、回退保护、生产 test gate，以及禁止 data purge/开放 LAN。只有这一次正式批准覆盖整个安全 rollout；批准后 Round 2 内不逐步要求重复确认。若漂移、权限异常、真实数据不可恢复或升级既有架构，属于仍必须停的 Hard Gate。

**这是两轮上限，不是违反安全条件仍承诺成功。** 已批准能力内的缺陷必须在其所属轮次消化完；只有无法安全解决的重大新风险可能阻断交付。除最后必要的人工发布授权，不把正常测试、CI、报告、安装回滚拆成单独一轮。
