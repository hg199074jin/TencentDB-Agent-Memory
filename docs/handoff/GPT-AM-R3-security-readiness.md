# GPT-AM-R3｜Agent Memory 安全上线准备（仅隔离开发）

**本文件是开发授权范围内的实施方案，不授权任何生产切换、重启、密钥轮换、迁移或主分支合并。**

基线：feat/gpt-am-sec-002-containment @ 44f7b977de86e9fe17f60b174ee7a57b92ba6b81。生产已完成 Stage 1/1B：宿主 Core 8420、Hub 8125/8424、Proxy 8096 都仅绑定 127.0.0.1；本阶段不得改变。独立 worktree 和分支 feat/gpt-am-r3-security-readiness，从此基线开发。保留 macos-memory 的 staged 修改及 Mac 运行配置。

一个大里程碑连续完成：真实代码阅读 → RED pins → R3 correctness → 端口 guard 和可版本化安全部署方案 → Proxy Bearer 兼容 → scoped 认证隔离验证 → L1/L2/L3 → 证据/文档 → commit/push → STOP 生产 Hard Gate。不因正常提交、推送、测试逐项请示。

## M0：基线与威胁模型

读取当前真实源码和最新官方实现；核对 MemoryProxy/src/auth.ts 的 verifyUserKey、pipeline/stages/auth.ts、config.ts、types.ts，MemoryCore/src/gateway/server.ts、v2-router.ts、metadata auth 和 team/agent ACL，Hub/Panel 的 Core 调用、各启动脚本与 ops/loopback-guard.sh。只读检查生产 Docker publish、volume、镜像 ID、密钥存在性/文件权限，不能输出生产 key 或真实 L0。

模型：服务级 Gateway Bearer 并不证明 user_id/team_id/agent_id 的所有权；body/header 的 user_id 只是自称身份。区分单用户 Mac 主机上的恶意本地进程与多用户服务器攻击。所有复现用隔离容器/合成账号，不能读取生产真实历史。

## M1：R3 三项正确性修复，先写 RED

**A. spool 内容匹配误去重**：integrations/agent-memory/src/capture.mjs 的 retryQueuedCaptures 仍用 alreadyStored 文本相同即 markAcknowledged(suspected) 并将队列项删除。两次不同 turnId、同一 session、完全相同问答：第一轮已存，第二轮 definitely_not_sent 入 spool → 恢复时第二轮必须被写；若第二轮 maybe_sent 则保持 unknown 且不得盲重发，也不得把第一轮匹配冒充第二轮已 ACK。强默认：队列强制 turnKey，只有该 key 的真实 durable ACK 才自动出队；unknown 可报告 suspected 但不得由内容匹配自动升 acknowledged/删除。涉及 capture.mjs、dedupe.mjs、state-store.mjs、hook-cli.mjs 和对应 test。服务端无 idempotency_key 时仅 best-effort，不能宣称 exactly-once。

**B. 网络状态分类**：integrations/agent-memory/src/core-client.mjs 中 NOT_SENT_CODES 的 ECONNABORTED 不能证明请求未送达。写 RED：服务端已落库、连接断开 ECONNABORTED，必须 maybe_sent → unknown，绝不盲重试；只有可靠的连接建立前拒绝/DNS 错误或未开始请求才 definitely_not_sent。网络异常、部分 body、ACK 丢失、复合 cause 的测试均覆盖。无法证明 pre-send 就保守 unknown。

**C. 跨进程旧状态覆盖**：dedupe.mjs 的 persist merge-on-write 用本进程整张 memory Map 覆盖 onDisk。旧进程写另一 key 时可能把新进程同名 key 的 acknowledged/unknown/denied 回写成 stale pending/sending。写两个进程交错时序的 RED：任何已有终态不得倒退；不同 key 同时更新保留两者。推荐仅在写锁内刷新磁盘并更新**目标 key**，严格状态迁移、持久性/写锁 owner/崩溃/损坏数据 fail-closed；若要用 SQLite 也只在隔离运行环境实施，不迁移生产。测试磁盘不可写、文件损坏、进程 kill、锁超时。主 Agent fail-open，记忆不安全时 deferred。

## M2：防端口重新暴露——只改源码及隔离部署

现有 ops/loopback-guard.sh 会在容器无 Host PortBindings 时说 OK、启动脚本缺失时跳过、仅 grep 文本匹配 HOST_BIND:-127.0.0.1、对已停止容器仅 inspect 也视为正常。它只能当弱证据，不能作上线门禁。

RED：四个要求的端口少一个、额外对外端口、IPv6 全接口、容器 stopped、不存在的 deploy 脚本、注释中假命中、实际 -p 仍是 0.0.0.0、错误 override、旧源脚本部署复发暴露，全部 FAIL；精确四端口绑定 loopback 且容器健康、脚本解析确认实际 publish 安全才 PASS。把 expected maps 声明式固定。真实生产外部依赖有其他端口则显式列入安全例外并要求批准，不要自动视为允许。

GitHub SEC-002 分支目前仅有报告 + ops guard，没有原地生产 staged 的三份脚本补丁。请在**隔离分支**构造安全默认的 deploy/global-images/start-memory-core.sh、start-memory-hub.sh、start-proxy.sh 补丁或可重入 installer；不覆盖或 commit 生产 staged 文件，也不破坏原有改动。宿主 host publish 默认 127.0.0.1，容器内仍监听 0.0.0.0。加 CI shellcheck + mock docker tests，至少提供 deploy preflight 阻止未经验证的发布（但不得谎称能拦住所有裸 docker run）。不允许重新部署生产。

## M3：Proxy → Core 的强 Bearer 兼容（只在隔离）

腾讯云上游 start-memory-core.sh 第 22–34 行明确说明：MemoryProxy/src/auth.ts 的 /v3/meta/auth/verify 调用缺 Authorization，先开启 TDAI_GATEWAY_API_KEY 会破坏 auth/session-init。Proxy 其他 Memory/Skill/Knowledge 路径使用 tdai.apiKey/serviceToken；Core gateway 全路由除了 health 都需要有效 Bearer。

RED：隔离 Core 启强 Bearer，当前 Proxy verifyUserKey 必失败；修复后 user-key 正确且 service Bearer 正确 → 返回可信 user_id；key 错误/缺失、Bearer 错误/缺失、Gateway 401/403、连接错误均拒绝，不能回落 anonymous 或默认 team。

推荐变更面：MemoryProxy/src/types.ts AuthConfig 增加可选 serviceBearer（或复用配置管理中唯一合法的现有 Core 服务密钥字段）；MemoryProxy/src/config.ts buildConfig 映射受保护的 Core secret；MemoryProxy/src/auth.ts initAuth / verifyUserKey 为服务端 auth/verify 请求添加 Authorization Bearer。不得把客户端 user_key、模型上游 LLM API key 或管理员 user_key 冒充服务级 Gateway key；密钥不得进入日志/PR。旧 auth 禁用模式应兼容但启动时高可见 WARN，不得因服务级凭据错误偷偷降级。

全面检查 Hub/Panel、Proxy 的所有 Core API 调用，隔离全栈验证 metadata auth、session-init、L0/L1-L3、Knowledge tools、代理模型流。使用从当前源码独立构建并标记 commit/digest 的隔离 Proxy 镜像，不能用旧固定 digest 假装测试了新源码。隔离 Core 强 Bearer 也要按相同密钥传递给 Hub、Proxy 和合成 Hook 客户端。

## M4：服务器 scoped user identity（仅隔离研究/实施，遇架构门停止）

在 MemoryCore v3 数据面验证五种越权：合法服务级 Bearer + 缺 user-key；伪造 user_id；team 非成员；agent 无权限；请求身分与 user-key 对应 user_id 不一致。读 L0/L1/L2/L3 和写 L0 均应拒绝，不泄真实内容；先写实际攻击复现 RED。

强默认：经 metadata auth 验证 user-key 得真实用户 principal，再校验团队成员关系、agent access/ACL；所有用户/团队/agent 选择仅由已验证 principal 授权，禁止信任 body。考虑为 v3 data plane 增加 opt-in scopedAuthEnabled 以保留旧调用兼容；内部高权限调用必须显式独立 service principal/权限范围，不能让所有持有服务 Bearer 的普通 Hook 成为全域管理员。检查旧 v2/bridge 路由能否绕过认证策略。

**如涉及生产 schema/migration、需要新的密钥分发体系、改变现有 metadata 权限语义、影响已批准架构，STOP 在真实 architecture Hard Gate**，只提供最小兼容方案与隔离证据，不擅自扩大授权。可以推荐只代理 Memory 控制流的本地 scoped broker，但不能转发/接管任意 Agent 的 LLM 路由。

## M5：验收/交付

- 在独占 worktree 一次完成可安全连续步骤，L1 targeted → L2 regression → L3 isolated full acceptance；至少含上述异常注入和 scoped 越权测试、容器三件套联合健康及真实合成请求、四端 Hook/Plugin 合成契约，固定测试镜像和测试配置 fingerprint。每次测试仅隔离数据卷，失败路径也清理。
- 文件：docs/agent-memory/ZCODE-AM-R3.md（逐项 RED/GREEN、根因、diff、测试命令/数量、真实证据、残余风险）、docs/agent-memory/PROD-AUTH-ROLLOUT.md（**仅预案**：Proxy/Core/Hub 联动密钥、权限、密钥轮换、升级顺序、不同步重启的风险、安全回滚及四端灰度），更新 ARCHITECTURE 和 TEST-EVIDENCE。
- 推送到个人 Fork 的 feat/gpt-am-r3-security-readiness，不 merge 主线、不发公开上游 PR、不改生产容器/环境/配置/真实 memory 数据/密钥/Hub Proxy 现役镜像或四端 Hook。
- 若全部隔离验证通过报告 PASS_ISOLATED；若 M4 触及真实架构门报告 PASS_WITH_ARCH_GATES；失败如实 FAIL。下一次单独取得用户生产变更授权才可启用 Gateway 强 Bearer 或 scoped auth、镜像切换及四端新版 Hook。
- 未经用户明确授权，不得执行线上任何变更；前两次端口安全止血的批准不能沿用为本轮上线授权。
