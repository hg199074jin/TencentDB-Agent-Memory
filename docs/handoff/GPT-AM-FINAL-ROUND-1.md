# GPT-AM-FINAL / ROUND 1 of 2｜一次完成 V1 最终功能、安全架构、源码修复与隔离发布候选

**本文件取代此前尚未执行的 GPT-AM-R3-R1-independent-review-remediation.md。禁止将两份指令叠加执行。**

目标不是再做一轮零散修复，而是在**本轮结束时给出完整、可部署但尚未切换生产的 v1.0 Release Candidate (RC1)**：四客户端模型无关共享记忆 + 正确可靠的 L0 记录 + 服务端强 Bearer 和用户 scoped 权限 + 完整安装回滚 + 端到端验证。下一轮只能做独立验收、必要缺陷修正、生产上线与终验，不能再随意扩大功能。

基线：Fork 分支 `feat/gpt-am-r3-security-readiness@aa9d67e23f96e54d685aa0de5ac6309998461dfa`。当前 Mac 上生产 Core8420、Hub8125/8424、Proxy8096 均已收敛至 `127.0.0.1`；不得改变运行态。R3 已实现 correctness 与 Proxy Bearer 初步补丁，但**仍有 P0 认证 fail-open、测试不可复现、spool/reconcile/ACK 契约问题**。若当前仓库存在后续变更，先只读核对 HEAD、drift 和其他写者；以唯一工作树执行。

**授权边界**：用户转交本指令，即授权在独占工作树实施本文明确规定的 Core scoped-auth 架构扩展（默认关闭、兼容模式、无生产迁移），以及全部隔离测试。**不授权生产重启、镜像替换、密钥变更、修改现役 Hook、向腾讯官方提交 PR、merge 本仓库 PR**。确需数据格式破坏性迁移、跨项目写入、让服务级 Bearer 变成无限制管理员或不可兼容的 API 行为，则 STOP 说明原因，不得自行扩大安全边界。

## 0｜交付边界与冻结范围（不得添加第三个里程碑）

本地 v1.0 DONE 必须达到：
- Codex / Claude Code / ZCode 的 Hook 与 OpenCode 的 Plugin 使用原始模型/API/provider/OAuth，不要求切换为 `tencentdb-agent-memory` 模型，正常互动均可在同一授权记忆作用域完成 recall + capture；Proxy 路径共存，不双重注入/写入；
- Core v3 数据面实现**服务凭据和真实用户身份双层验证**，user-key 验证 user_id、team membership、agent ownership/access，并与具体记忆资产 ACL 对齐；对未授权/跨用户/跨 team/agent 的读写先拒绝后查询，既不泄露记录也不落库；
- fail-open 仅限 Agent 主业务（memory 出错不影响回答），**安全鉴权和抓取持久性 fail-closed**；同 turn 重复 Stop 不重复写、不同 turn 同内容不得丢；无 server idempotency key 时报告 best-effort 和不确定态；
- 安全本机端口及 Gateway 强 Bearer 能在独立镜像与部署脚本下可靠复现，合法合成用户可端到端通过，非法拒绝；
- 安装器备份+卸载还原、隐私 opt-out、过滤凭据、untrusted 注入、健康自检和回滚真实可用。
不包括：云上多租户 SaaS 产品化、跨设备公网暴露、历史 5200 L0 迁移/自动清洗、改变 Tencent 官方 Proxy 的业务定位、未经官方审查强行合并上游、无限客户端版本支持。OpenCode TUI 是必须验收的主要模式；`opencode run` 若官方事件契约无法辨别 completion，不允许造假记已支持，须在最终支持矩阵明确限定。

## 1｜执行模式（一次到终点）

建立单写者 worktree `feat/gpt-am-final-r1-rc1`，严格按下面先 RED 后 GREEN。一个大任务连续做完：tests → 核心实现 → 文档 → commit → 本地+隔离验证 → push → Fork PR → CI → `ZCODE-AM-FINAL-R1.md` → STOP 仅一次。L1 模块+smoke，L2 跨模块回归，RC1 必须 L3 全量测试。不得遇到普通失败就请求人工新 Issue：本轮内自行定位修复并复测。若必须触 Hard Gate，附单一最小差异方案与精确 blocker，不自行编第三轮。

## 2｜P0：修掉所有鉴权 fail-open（不能遗漏）

已实证源码：`MemoryProxy/src/auth.ts:initAuth` 若 enabled=true 但 serviceBearer 为空会 WARN 后 return；模块 config=null，`verifyUserKey` 中 `if(!config) return {rejected:false}` 于是直接放行。缺 auth.url 同病；错误重初始化还可能沿用旧 token。

推荐实现：`AuthRuntimeState={mode:"disabled"}|{mode:"ready",config}|{mode:"misconfigured",reason}`，`initAuth()` 任何配置都会**替换**旧状态。只有显式 `enabled:false` 允许 passthrough；`enabled:true` 的缺 url、缺 Bearer、坏配置、Core401/403/500/timeout/异常 envelope 一律 `rejected:true` 且不能转发 LLM 请求、不能回落 anonymous/默认 user。`isAuthEnabled` 与所有调用点对 misconfigured 状态也必须视为要求鉴权，绝不可绕过 `stageAuth`。审计 `MemoryProxy/src/config.ts:buildConfig`、`types.ts:AuthConfig`、`pipeline/stages/auth.ts`、openai/anthropic/codex/workbuddy 等所有入口。兼容仅本地明确禁用 auth 的既有运行模式，但生产启强 Gateway 强鉴权时不得使用该模式。

TDD RED：缺 serviceBearer、缺 auth.url、缺 enabled 但用户误以为打开、先 valid 再 invalid reinit、再恢复、Core 401/500/timeout、bad envelope；mock upstream 断言始终零调用。保留 valid key → valid user_id 的正例。

## 3｜P0：Core 的服务端 scoped 权限必须在本轮**实现**，不是只提交架构提案

已实证：`MemoryCore/src/gateway/server.ts` / `v2-router.ts:handleV2Route` 当前严格隔离只要求 body/header 自报 user_id/team_id/agent_id；强服务 Bearer 不绑定用户。元数据已有 `metadata/router/auth.ts:authenticateV3`、`MetadataService.verifyAuth`、`store.getTeamMember`、`store.getAgentById` 和资产 `checkPermission`，优先复用，不新增平行认证数据库。

**Normative 安全合同**：
1. 增加可选 `scopedAuthEnabled` / `TDAI_GATEWAY_SCOPED_AUTH`（推荐 server 配置层）默认 false 以兼容老部署；若 true 而 Gateway 服务级 Bearer 未启用，**启动拒绝**；保留 host publish loopback；
2. 数据面身份来自可信 `x-tdai-user-key` 经 `authenticateV3/MetadataService.verifyAuth` 验证，建立 request-scoped principal：`{instanceId,authenticatedUserId,teamId,agentId,action}`。拒绝空/无效/过期/撤销 user key；
3. body/header 的 user_id 如果指定，则必须与 principal.userId 一致，否则 403；没有请求身份不得 fallback 匿名/default。先核对 active team membership；agent 必须存在且归属 team；结合 owner、chat_memory 资产 bind/visibility/ACL 判定 read/write。**同一已授权作用域**的四客户端应继续共享，而不是因 client 名不同被拒；
4. Core 数据面所有 L0/L1/L2/L3 读写和相关路由（conversation/add/query/search、atomic、scenario、core、相关 clear），在任何 store query/write / 资产自动登记副作用之前完成授权；梳理 v2 legacy alias、v3 chat-memory/bridge及管理面，不能形成绕过。对无法兼容的 v2 数据入口，在 scoped 模式明确拒绝/限权，不允许“v3 拒绝而 v2 可读同记录”；
5. 服务级 Bearer 只证明服务调用资格，**不是超级用户万能通行证**。Proxy/Hub 访问数据面须传播已验证的真实用户身份，后台无用户调用须通过单独最小权限 service principal + 精确路径/action allowlist，禁止任意带 serviceBearer 就 bypass；系统管理端点应限制可触达性与用途；
6. 异常采用 401（缺/错用户 key）、403/404（scope 越权）、503（元数据临时失败且需拒绝），响应不含敏感记录/私密资产存在性。显式文档说明本机同 OS 账号读取配置中的合法凭据是 OS/文件权限威胁，不能声称抵御同权限本机进程；
7. 数据库存储结构原则不变；若新增数据库 migration，严格 Hard Gate 不执行生产迁移。
**强默认改动面**：`MemoryCore/src/gateway/config.ts` + `server.ts`（注入安全依赖）+ `v2-router.ts`（统一 data-plane gate）+ 新 `MemoryCore/src/gateway/scoped-authorization.ts`（principal 和 allow/deny）+ metadata service/store 复用。设计 `authorizeMemoryRequest({req,body,serviceId,route,action,metadataService})` 在调用 handler 之前严格返回授权结果。不要把 ACL 仅写在 client identity.mjs 或 Proxy 层。

**先写真 RED 再 GREEN**：隔离库创建 user A/B、team A/B、agent A/B，B 的合成 L0 与 L1/L2/L3，A 合法 Bearer + user-key 冒充 B 的五类攻击，需确证 B 数据**零泄漏**和写路径**零落库**；缺 user-key、伪造任意字段、非法 agent、失效 key、跨 serviceId、v2 绕过、内部 service 不当绕过；合法同作用域的四种客户端身份成功 recall/capture，跨客户端同一 asset 共享。每条记录 HTTP status、响应 code、落盘行数和 request_id（不打印密钥）。

## 4｜P0：spool / reconcile / ACK 严格一体化

已知源码问题：`integrations/agent-memory/src/dedupe.mjs:reconcile` 仍以内容匹配命中升级 acknowledged(suspected)；`capture.mjs:retryQueuedCaptures` 直接 addConversation 绕过 execute 的 per-turn 锁和持久发送前状态，且 `markAcknowledged` 未校验持久化成功就出队。另 `state-store.mjs:normalizeCapture` 仍用 (sessionId,messages) digest 做排队去重，即不同 turnKey 若 timestamp 相同可能被折叠。

**强默认状态机**：`pending→sending(durable)→acknowledged(durable)`；发送是否到达不可判定→`unknown`（永久禁盲重试），明确 pre-send 失败→`retryable`；业务拒绝→`denied`。服务端没有同 key 回执就只能 suspected，任何 reconciliation 不得把 suspected 升 durable ack。spool 的 primary key 是 `turnKey`，仅 legacy 无 key 记录才走隔离隔离/人工处理；queue digest 不得将两个不同 key 合并。retry 与 execute 共用同一 per-key owner lock、pending/sending 持久化和 ACK 成功落盘检查；磁盘满/不可写不能删除 queue 或报告 durable ACK。发送有成功但状态文件写失败，仍保留不确定态并阻止重发。修复 `dedupe.execute()` 同类 ACK 状态误报；严格审查 owner token 释放与 30s stale 竞态。

TDD：两个同时重试进程、相同 Q/A 的两个 turnKey（包括相同 timestamp）、发送前/后 kill、ACK 前/后 fsync 失败、ENOSPC、已落服务端但 ACK 丢失、reconcile suspected、queue 恢复、state.json corrupt。要求不因同内容丢合法 turn，不因为状态未知盲发。保留 best-effort 语义，不宣称 exactly-once。

## 5｜P0：安全部署脚本进入 Git 版本基线

现状 SEC-002/R3 的 Mac 本地三份启动脚本已 patched，但 Git 分支中未提交实际启动脚本的 loopback 修改，回退源部署会重暴露。于独立 worktree 修改 `deploy/global-images/start-memory-core.sh`、`start-memory-hub.sh`、`start-proxy.sh` 的宿主 `-p` 默认到 127.0.0.1，容器内继续 0.0.0.0；配置强校验：如指定 HOST_BIND 非 loopback 则直接拒绝（v1 仅本机），绝不 silent allow unsafe override。保留用户 Mac 现有 staged 改动，不 reset/clean 或覆盖生产项目目录。

`ops/loopback-guard.sh` 严格验证 expected 4 ports/3 healthy 容器、无 unapproved extra、启动脚本真实 docker publish、禁止 IPv6 wildcard；配套 source-only preflight（部署前不要求生产容器已存在）+ runtime postflight；两者都接入正式部署流程。测试模拟错端口/删脚本/坏覆盖/假注释/非运行容器/缺端口；尽量不依赖不安全的 shell 正则解析。shellcheck + CI 通过。

强 Bearer 部署配置需要同时覆盖 Core Gateway、Proxy auth.serviceBearer/tdai.apiKey/skill/knowledge、Hub REMOTE_INSTANCE_KEY 和四客户端；脚本中所有 secret 只以安全 env/权限受控文件加载，不写进 Git/log。不得改本机生产配置。本轮输出 `docs/agent-memory/PROD-DEPLOY-RUNBOOK.md`：预检→镜像固定→备份→同密钥桥接→Core scoped auth→实际功能→四端灰度→快速恢复到**仍保持 loopback + 拒绝未授权**的安全状态；不用“关闭强 auth”作为自动回滚。

## 6｜四客户端端到端正确性、最小支持矩阵与可安装交付

源码范围：`integrations/agent-memory/src/config.mjs` / `core-client.mjs` / `identity.mjs` / `hook-cli.mjs` / `install-hooks.mjs` / `plugin/opencode-cross-agent-memory.js`（以真实仓库文件为准）。扩展受保护客户端配置：除了 service Bearer `apiKey`，新增唯一明确的用户 `userKey`，CoreClient 所有需要 scoped 的 Data API 携带 `x-tdai-user-key`；不把 user-key 放入日志/注入上下文/捕获文本。用户 ID 不信客户端自述，必须与服务端解析一致。

三种 Hook 正确读取当前客户端事件与 session/turn/final assistant；OpenCode TUI 以 SDK 的真实回调保存 final response；Proxy provider 双路互斥。安装器事务化备份，uninstall 恢复原配置（包括已有用户自定义 hooks），不覆盖用户其它插件；Doctor 给出“Gateway auth、scoped auth、identity、权限、spool 队列、端口”诊断，注意不得打印凭据。失败时主 Agent 不被阻断且不错误存储；正常 case 1 次 stop→1 对 L0；旧记忆 L1/L2/L3 按配额准确进入模型，historical-trust notice 不授予工具权限；隐私 opt-out、key/redaction tests 与已有功能不回退。

**证据粒度**：isolated E2E 至少分别验证 codex、claude、zcode 三套事件 JSON，经编译实际 hook 进程；OpenCode 插件真实 SDK event mock + 若本机具备 UI/CLI 则真实互动；正常调用分别写四条独立记录，交换客户端再次 recall 命中共享记忆。四客户端各确认没有改 model/provider/baseURL 且无 MemoryProxy hop。不能用 API 层测试谎称真实桌面 UI 验证。

## 7｜L3 测试要可复现，而不仅有日志

现有 `ops/e2e/run-r3-security-e2e.sh` 用 `git show HEAD:MemoryProxy/src/auth.ts` 做 RED，但 R3 HEAD 已 patched，提交后无法重复；`proxy-bearer-e2e.mjs` 只打印字段并无 assert，异常时可能错误返回 0；`scoped-identity-probe.mjs` 仅打印攻击通过但没有新 gate 的拒绝断言。修复为**固定未修复 commit 44f7b977** 或独立旧行为 fixture；从“干净 checkout 的最新 HEAD”执行全部验证。每个 HTTP 401/403/200、正反向上游是否触达、写入数据行数、Core Bearer、双身份 ACL 都必须 assert 并令退出码反映失败。测试容器/卷名称使用专属标识和 ownership guard，不以 `rm -f` 删除别的同名容器；任何失败都清理**自己**创建的资源，保护生产。新 Core scoped 代码必须从**当前提交构建隔离测试镜像并记录 fingerprint**，不能用旧生产 core digest 验证新身份代码。Docker 构建网络不通时优先可审计的本地 build/离线依赖方案，不能因编译失败便跳过隔离真实 Core 测试却宣称通过。

L1 targeted；L2 impacted full tests；L3 RC1 全量 `npm test` / 相关 Core/Proxy typecheck/build/regression + E2E 全链路 + 部署 source/runtime mock、TDD负例。从干净 checkout 重跑时能重复 PASS，密钥用临时随机合成值。

## 8｜Round 1 必须交付，不再另起修补 Issue

1. `docs/agent-memory/ZCODE-AM-FINAL-R1.md`：HEAD SHA / diff surface / RED→GREEN / 测试命令与断言数量 / 容器 build fingerprint / 5类越权真实拒绝 / Proxy鉴权缺配拒绝 / 四客户端证据 / 未覆盖模式 / 不可避免限制；
2. `docs/agent-memory/RELEASE-CHECKLIST.md`：逐项完成度、一键复现、四客户端支持矩阵、隐私/权限、runtime指标、Release candidate 版本指纹与 rollback；
3. `docs/agent-memory/PROD-DEPLOY-RUNBOOK.md` + `docs/agent-memory/ARCHITECTURE.md` + `docs/agent-memory/TEST-EVIDENCE.md`；
4. 独立 feature 分支 push，创建**本人 Fork 内** PR（如仓库允许），CI 完成；若某项 Red 未消灭、生产需要不可逆 migration 或使用非批准 admin bypass，R1 必须明确 FAIL/HARD_GATE，不能虚报 RC_READY；
5. 成功标准 **RC_READY**：功能与安全全部在隔离环境通过，仍**未上线**。STOP，交给 GPT 独立验收后仅剩 Round 2——生产授权、最终验收及交付。

> 执行策略：若发现新的同类型低中风险缺陷，在本轮内直接修正；不要用“再开一轮”的形式回传。仅不可兼容架构/权限/真实数据库破坏性风险属于 Hard Gate。上游官方是否接收 PR 不在本地 v1.0 的完成标准中。
