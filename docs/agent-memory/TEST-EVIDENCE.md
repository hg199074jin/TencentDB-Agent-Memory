# TEST-EVIDENCE — GPT-AM-001

> 实施分支 `feat/gpt-am-001-agent-memory`（基点 upstream `274e549`）
> 全部测试使用**合成语料**与**隔离 Memory 实例**（容器 `am001-e2e-core`，端口 `18420`，
> 卷 `am001-e2e-data`），未触碰生产 `tdai-*` 容器与 5200+ 条生产 L0。

## 1. 测试矩阵与结果

### 1.1 单元/模块测试（18 套，全绿）

```
$ cd integrations/agent-memory && npm test   # node --test test/*.test.mjs
ℹ tests 18   ℹ pass 18   ℹ fail 0
```

| 套件 | 覆盖 | 关键断言 |
| --- | --- | --- |
| `identity.test.mjs` (7) | 授权作用域 | 完整配置解析；缺字段拒绝；伪造 scope 被 allowlist 拒绝；空 serviceId 拒绝 |
| `core-client.test.mjs` (7) | v3 契约 | 方法名/路径/隔离字段与官方 SDK 一致；envelope 错误抛错；传输错误分类；超时 abort；withIsolation 不污染 |
| `recall.test.mjs` (7) | 召回契约 | L1+L3+L2 并行；XML 逃逸中和；字符预算；逐层降级；query 剥离注入块；条数上限 |
| `privacy.test.mjs` (3) | 隐私 | opt-out/凭据跳过；data-URI 替换；注入块剥离 |
| `dedupe.test.mjs` (8) | 幂等 | turnKey 覆盖 7 维；状态机；unknown 不重试；reconcile；重启持久化；verify 先于 send |
| `capture.test.mjs` (11) | 回合捕获 | 一对 user+assistant；cancelled/failed/空 final 跳过；隐私跳过；同 turn 去重；异 turn 不误去重；unknown 不盲目重试；发送前失败可重试；读回去重；重启幂等 |
| `observability.test.mjs` (2) | 指标 | 计数/分桶/失败分类；快照无原文 |
| `opencode-adapter.test.mjs` (7) | OpenCode 适配 | 召回+注入；proxy provider 跳过注入/写入；补写上轮；重复事件不双写；身份 fail-closed；Core 停服 fail-open |
| `hook-cli.test.mjs` (1 大) | 三客户端进程契约 | stdin/stdout 契约；并行客户端；重复 Stop 归并；故障 fail-open；无原文泄漏；status 日志字段白名单 |
| `state-store/bootstrap-config/config/doctor/install-hooks/metadata-client/restore-claude-minimax/opencode-plugin` | 回归 | 既有契约不回退 |

### 1.2 隔离 E2E（gates A–H，全绿）

```
$ node --test test/e2e-isolated.test.mjs
✔ A model-agnostic: both clients recall/write with their own provider (857ms)
✔ B cross-client scope sharing and forged identity rejection (31ms)
✔ C capture accuracy: repeated events, restart, concurrency, new turns (5.9s)
✔ D fault isolation: core down does not block agents (5.8s)
✔ E privacy: opt-out, secrets, data-uri, injected blocks stay out of L0 (2.6s)
✔ F proxy coexistence: proxy-provider session stays silent (12ms)
✔ G distillation: L0 ack leads to retrievable L1 within budget (48.8s)
✔ H latency budget (3.5s)
ℹ pass 8  ℹ fail 0
```

各 gate 实测证据：

| Gate | 实测 | 结果 |
| --- | --- | --- |
| A 模型无关 | hook（codex 线路）与插件（step-5 线路）各自完成 recall+write；请求只到 `:18420`，未触 8096 | PASS |
| B 跨客户端 | 客户端 A 写入的合成标记可被客户端 B 召回；伪造 team（allowlist 外）零注入 | PASS |
| C 记录准确 | 30 次重复 Stop → L0 恰好 1 条 user 记录；进程重启后同 turn 不重写；3 进程并发 ≤2 条（读回兜底）；新 prompt 正常新写 | PASS |
| D 故障隔离 | Core `docker stop` 后 UserPromptSubmit 仍 <3s 返回 `{}`；Stop 正常响应；恢复后健康 | PASS |
| E 隐私信任 | `[不记忆]`/`/nomemory`/`sk-`/`Bearer`/data-URI/注入块 6 类用例 0 泄漏；注入块剥离后干净文本仍入库 | PASS |
| F Proxy 共存 | provider=`tencentdb-agent-memory` 会话：零注入、零写入 | PASS |
| G 提炼效果 | L0 ACK 后 Core 异步管线将合成决策提炼为 L1，`atomic/search` 48.8s 内可检索（非"仅写 L0"） | PASS |
| H 延迟预算 | recall 5 次采样全部 <1200ms 预算+slack；capture 3 次 <3000ms 预算+slack | PASS |

### 1.3 隔离性证明

- E2E 使用独立容器 `am001-e2e-core`（`127.0.0.1:18420`）与独立卷 `am001-e2e-data`，
  测试结束后 `docker rm -f` + `docker volume rm` 清理；
- 生产容器 `tdai-memory-core/hub/proxy` 全程未停未改（E2E 前后 `docker ps` 与 `/health`
  状态一致，proxy/hub uptime 连续）；
- 合成语料含随机标记（`AM001-SYNTH-*` / `AM001-PRIV-*` / `AM001-DISTILL-*`），
  与生产数据无交集；未读取、未迁移、未清理任何生产 L0。

## 2. 复现命令

```bash
cd /Volumes/ORICO/Projects/TencentDB-Agent-Memory-GPT-AM-001/integrations/agent-memory
npm test                 # 18 套模块/集成测试
npm run test:e2e         # 隔离 E2E（自动起停 am001-e2e-core，需要本地 agentmemory/memory-core:latest 镜像）
```

E2E 的 LLM 配置从生产 `.env` 的 `MEMORY_LLM_*` 读取（仅用于隔离实例的提炼管线），
可用 `AM001_PRODUCTION_ENV` 覆盖路径；密钥只进容器环境变量，不落库、不进日志。

## 3. 已知限制（实测记录，非伪装通过）

1. **服务端身份绑定缺失**：错误/缺失 `x-tdai-user-key` 仍可读写（M0 §5 实测）。
   客户端 allowlist 只是纵深一层；部署侧加固是生产启用 Hard Gate（ARCHITECTURE §6）。
2. **并发竞态**：3 进程并发 Stop 同会话最多观察到 2 条 L0（读回校验兜底，非严格
   exactly-once）；服务端 `idempotency_key` 提案见 ARCHITECTURE §5。
3. **OpenCode `opencode run`（非交互）**：assistant 完成事件不带 `time.completed`，
   该子模式不触发写入；TUI 正常（用 `chat.message` 补写 + `session.idle`）。
4. **OpenCode 2.x**：本适配器按 1.18.x 插件 API 实现；2.x 的 `providers/package/settings`
   结构差异需单独验证（生产现为 1.18.35，无兼容性问题）。
5. **L2/L3 观察**：E2E G 门验证到 L1 可检索；L2/L3 由 Core 管线异步生成，
   生产实例长期观察有效，隔离实例内未单独设断言（等待预算内未强制）。

## 4. R2 收口证据（2026-10-11）

### 4.1 测试规模

```
npm test           → 19 套 / 125 断言全绿（含 delivery/dedupe/capture 的 R2 RED pins）
npm run test:e2e   → 12 测试全绿（gates A–K；镜像固定 digest sha256:338847edc646…）
```

### 4.2 历史数据与修复后数据（证据一致性勘误）

| 观测 | 发生条件 | 现状态 |
| --- | --- | --- |
| “3 进程并发最多 2 条 L0” | **锁修复前**（DB9/D9 无 owner 宽限期，存在抢锁窗口） | 已定位为真实竞态并修复；D9 连续 5 次恰好 1 次发送；E2E-C3 断言收紧为 `=== 1` |
| “4 进程恰好 1 次发送”（ZCODE-AM-001） | 修复初期断言，但当时存在偶发双发 | 修复后 5/5 稳定通过 |
| maybe_sent 被当 retryable | P0-A：错误无 delivery 字段 | DA1–DA7 + E2E-J：全部改为判别联合，maybe_sent→unknown 禁重试 |
| 内容匹配自动 ACK | P1-E：同内容不同 turn 被漏记 | DC1：同内容不同 turn 两组都写；DC2/D8：内容匹配仅 reconcile 疑似信号 |

### 4.3 新增/变更的关键 pin

| 套件 | pin | 断言 |
| --- | --- | --- |
| delivery | DA1–DA7 | 三种 delivery 分类 + dedupe/capture 链路口迁移 |
| core-client | D-C1/D-C2 | `readScenario→{path}`、`listScenarios→{path_prefix}` |
| capture | D-L1–L3 | 8192 码点边界、超限跳过+reason、emoji 码点计数 |
| dedupe | DB1–DB4/DC1/DC2/D8/D9 | 锁不可用不发送、持久化失败降级、崩溃 sending→unknown、并发 key 不互覆、同内容异 turn 双写、suspected 标记、execute 无写前内容匹配、多进程恰好一次 |
| e2e | I/J/K | claude/zcode 真实 hook JSON；maybe_sent/refused/403 注入；ACK 崩溃恢复、磁盘满 deferred |

### 4.4 环境与隔离

- 隔离实例：容器 `am001-e2e-core` / 卷 `am001-e2e-data` / 端口 `127.0.0.1:18420`；镜像按 digest 固定；成功与失败路径均自动清理。
- 生产 `tdai-*` 三容器全程未停未改（E2E 前后 health/uptime 一致）。
- 合成语料 `AM001-SYNTH-*`/`AM001-PRIV-*`/`AM001-DISTILL-*`/`AM001-INJECTED*`，与生产 5200+ L0 无交集。
- 测试日志不打印生产密钥或真实 L0（E2E 仅从 `.env` 读取 LLM 配置注入隔离容器环境变量）。

## 5. R3 证据（2026-10-11）

### 5.1 规模

```
integrations/agent-memory  → 21 套 / 130 断言全绿（node --test test/*.test.mjs）
ops/test/loopback-guard    → 11 mock-docker 用例全绿
ops/e2e/run-r3-security-e2e.sh → 隔离全栈 RED/GREEN/负向/M4 全符合预期
```

### 5.2 R3 新增 pins

| 套件 | pin | 断言要点 |
| --- | --- | --- |
| r3-spool | SA1/SA2/SA3 | 同内容不同 turn 两组都写；unknown 不重发且内容匹配不自动 ACK；legacy 无 key 记录保留 |
| delivery（追加） | DB-R1–R4 | ECONNABORTED/复合 cause→maybe_sent；ENOTFOUND/ECONNREFUSED→definitely_not_sent |
| r3-crossproc | DC-R1–R4 | 陈旧 pending 不覆盖 acknowledged（修复前实测复现回退）；unknown 不被 sending 回退；损坏文件 fail-closed；磁盘不可写降级 |
| loopback-guard（mock） | G1–G11 | 精确四端口/缺端口/通配/IPv6/stopped/脚本缺失/注释假命中/错误 override/额外端口/批准额外端口/无端口发布 |

### 5.3 隔离安全 E2E（ops/e2e/run-r3-security-e2e.sh）

| 步骤 | 预期 | 实测 |
| --- | --- | --- |
| 强 Bearer Core 拒错 Bearer | 401 | 401 ✓ |
| M4 五类越权 | 全部 allowed=true（敞口 RED） | ✓（含伪造写 L0 落库实证） |
| Proxy RED（未打补丁 auth.ts） | 401 | 401 "auth service returned HTTP 401" ✓ |
| Proxy GREEN（R3 补丁 + 服务 Bearer） | 200 + 上游 | ✓ |
| 负向 ×3（错服务 Bearer/缺 user key/错 user key） | 401 | ✓ |

镜像固定：core `sha256:338847edc646…`、proxy `sha256:82df81d8af89…`（挂载源码运行，非重建镜像）。
隔离容器/卷/网络在脚本退出时清理（trap EXIT，含失败路径）。
