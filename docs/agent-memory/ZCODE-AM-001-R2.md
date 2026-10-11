# ZCODE-AM-001-R2｜独立复核收口 — 验收报告

- **Verdict：`PASS_WITH_IMPLEMENTATION_GATES`**（5 个契约缺陷全部 RED→GREEN 关闭；生产 Gateway 加固为唯一下一 Hard Gate，**未执行**，且核实为现实风险）
- 分支：`feat/gpt-am-001-r2-safety`（基点 `89ca160`，即 GPT-AM-001 报告 HEAD）
- 上游提案：TencentCloud/TencentDB-Agent-Memory#1631（**评论数实测 0**，见 §6 勘误）

## 1. R2 五项缺陷处置

| 级别 | 问题 | 根因（R2 前代码） | 修复 | RED pin | GREEN |
| --- | --- | --- | --- | --- | --- |
| P0-A | 网络异常可能重复写入 | `CoreTransportError` 无送达状态，dedupe 依赖不存在的 `afterSend` | `core-client.mjs` 引入判别联合 `delivery: definitely_not_sent / maybe_sent / rejected`（连接拒绝/DNS→未送达；发送后超时/断连/部分响应/5xx/408/429→maybe_sent；4xx/envelope 业务错→rejected）；dedupe 按 delivery 迁移：maybe_sent→unknown（禁重试）、definitely_not_sent→retryable、rejected→denied（禁重试不禁身份退化） | `test/delivery.test.mjs` DA1–DA7 | ✅ |
| P0-B | 锁失效仍放行写入 | `#acquireLock` 返回 null 后仍 verify→send；owner 无 token；stale 判定抢活锁 | 锁不可用→`deferred`（绝不发送）；owner token（pid+uuid+heartbeat）仅持有者可释放；`mkdir→owner.json` 窗口设 1s 宽限期（修复“读到空 owner 即抢锁”竞态，D9 由偶发双发修复为 5/5 恰好一次）；stale 回收需 pid 死亡或心跳超龄 30s；持久化 `sending` + 已持锁→`unknown`（崩溃不盲发） | `test/dedupe.test.mjs` DB1–DB4 + D9 多进程 | ✅ |
| P1-C | 持久化失败被静默吞 | `#persist` 异常空操作 | merge-on-write + 跨进程写锁（不同 key 并发不互覆）；持久化失败→`degraded`→后续 execute 一律 deferred；恢复成功自动清除；`denied` 短路 | DB1–DB4 | ✅ |
| P1-D | SDK 契约/长度不符 | `readScenario` 发 `scenario`、`listScenarios` 发 `session_id`；capture 允许 30000/60000 字符 | 对齐官方 v3：`readScenario({path})`、`listScenarios({path_prefix})`（sdk/.../v3/client.ts 逐字段核对）；单条消息 ≤8192 **码点**（v3-api 文档 §conversation/add），客户端前置校验（超限 delivery=rejected，不制造 spool 死循环），超限回合跳过+结构化 reason（不悄悄截断） | `test/core-client.test.mjs` D-C1/D-C2；`test/capture.test.mjs` D-L1–L3（含 emoji 码点边界） | ✅ |
| P1-E | 文本匹配误判已完成 turn | `alreadyStored` 内容匹配→自动 acknowledged，同内容不同 turn 被漏记 | turnKey 为唯一主判据，execute 不再接受写前 verify；内容匹配降级为 reconcile/spool 的“疑似”信号（`suspected:true` 明示）；unknown 保持需对账，不自动重发 | `test/dedupe.test.mjs` DC1/DC2 + D8 重写 | ✅ |

## 2. 验收证据（全部可复现）

```
$ cd integrations/agent-memory && npm test          # 19 套 / 125 断言
ℹ pass 125  ℹ fail 0
$ npm run test:e2e                                  # 隔离 Core（固定 digest）
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

| Gate | 结果 | 关键证据 |
| --- | --- | --- |
| A 模型无关 | ✅ | codex/claude/zcode hook 线路 + OpenCode 插件线路；请求只到 `:18420`，未触 8096 |
| B 跨客户端/越权 | ✅ | A 写 B 读同作用域；伪造 team（allowlist 外）零注入 |
| C 记录准确 | ✅ | 30 次重复 Stop→1 条；重启不重写；并发恰好 1 次发送（DB4/D9 多进程，5/5 稳定）；新 turn 正常新写 |
| D 故障隔离 | ✅ | Core 停服 recall <3s 返回 `{}`；Stop 正常响应 |
| E 隐私信任 | ✅ | opt-out/密钥/Bearer/data-URI/注入块 0 泄漏 |
| F Proxy 共存 | ✅ | proxy provider 会话零注入零写入 |
| G 提炼效果 | ✅ | L0 ACK 后 L1 可检索（30.7s / 48.8s 两次实测） |
| H 延迟预算 | ✅ | recall/capture 采样在 1200/3000ms 预算内 |
| **I Claude/ZCode 真实 hook JSON** | ✅ | 以真实 hook 输入字段（transcript_path/cwd/stop_hook_active）驱动，recall+capture 状态机正确 |
| **J 网络异常注入** | ✅ | maybe_sent→unknown 不重发；reconcile 命中→suspected acknowledged；definitely_not_sent→retryable；403→denied 不重试 |
| **K 崩溃/磁盘/锁** | ✅ | ACK 后重启不重写；磁盘写失败→deferred 不发送 |

镜像固定：`agentmemory/memory-core@sha256:338847edc646…`（不再依赖 `:latest`）。
E2E 容器/卷 `am001-e2e-core` / `am001-e2e-data` 自动清理（含失败路径）。

## 3. 测试证据一致性勘误（对 ZCODE-AM-001）

| 旧报告/证据 | 事实 | R2 处置 |
| --- | --- | --- |
| TEST-EVIDENCE 残留“3 进程并发最多 2 条 L0” | 该记录是**锁修复前**的观测；锁修复后 D9/E2E-C3 为确定性“恰好 1 次”（连跑 5 次） | TEST-EVIDENCE 已标注历史数据与修复后数据的差异（§5） |
| “4 进程恰好 1 次发送” | 修复初期偶发双发（owner 宽限期竞态） | 已在 R2 定位并修复；现 5/5 稳定 |
| Gate A=四客户端全模式 E2E | 实际为 codex hook + OpenCode 插件两条线路 | 新增 Gate I 覆盖 claude/zcode 真实 hook JSON；OpenCode `run` 模式限制如实保留（§4） |

## 4. 如实保留的限制（不伪称解决）

1. **OpenCode `opencode run`（非交互）**：assistant 完成事件缺 `time.completed`，该子模式不触发写入；TUI 正常。可检测（`process.argv`/事件特征）但未做成自动切换。
2. **OpenCode 2.x**：未覆盖（生产 1.18.35）。
3. **服务端无 `idempotency_key`**：客户端“最佳努力幂等”（持久化+跨进程锁+读回疑似判重），**不宣称全局 exactly-once**；服务端提案见 ARCHITECTURE §5。
4. **unknown 对账依赖内容匹配**：服务端无幂等键时，读回命中只是“疑似”；漏匹配时会保留 unknown（不盲发、不丢队列）。

## 5. P0-F：Gateway 鉴权与网络暴露（**STOP 项**）

只读实测（未改动生产）：

| 检查 | 结果 |
| --- | --- |
| Core 发布面 | `0.0.0.0:8420`（v4+v6） |
| LAN 可达 | `http://192.168.1.2:8420/health` → **200** |
| 未授权读取 | LAN + 伪造 team/agent + **无 user-key** → **返回真实 L0** |
| 内部网桥 | `tdai-memory-stack` 内 `memory-core:8420` 正常（proxy/hub 依赖，加固时必须保留） |

→ **触发 R2 规定的立即 STOP 条件**：未做任何生产配置变更。完整止血/加固/灰度/回滚方案见 `PRODUCTION-SECURITY-PLAN.md`（分阶段、每步可回滚、含 Docker 网络图与逐层健康检查）。**生产启用前必须完成阶段 1（loopback + 强 Bearer 两层同时做）。**

## 6. 勘误：#1631 评论数

API 实测 #1631 `comments: 0`。ZCODE-AM-001 中“对应官方 Issue #1631 评论中的 D 项”表述有误——该验收项来自本地 R2 评审而非上游评论，已更正。

## 7. 提交与边界

- 分支：`feat/gpt-am-001-r2-safety`（本人 Fork，未 merge、未动默认分支、未发上游 PR）
- 未改动：生产 worktree、macos-memory staged 副本、`~/.config/opencode/`、三客户端 hook 配置、运行中容器、生产 `.env`/L0
- **唯一下一 Hard Gate**：生产 Gateway 安全加固（loopback+强 Bearer）与灰度接入审批。
