# ZCODE-AM-R3｜安全上线准备 — 验收报告

- **Verdict：`PASS_WITH_ARCH_GATES`**（三项正确性修复 RED→GREEN 关闭；Proxy Bearer 兼容已隔离验证；服务端 scoped 身份绑定为架构级 Hard Gate，未实施）
- 分支：`feat/gpt-am-r3-security-readiness`（基点 SEC-002 `44f7b97`，本人 Fork）
- 授权范围：仅隔离开发。**未改任何生产配置/容器/镜像/密钥/记忆数据；四端口 127.0.0.1 绑定未动。**

## 1. M1 三项正确性修复（RED→GREEN）

| 项 | 根因 | 修复 | RED→GREEN 证据 |
| --- | --- | --- | --- |
| **A. spool 内容匹配误去重** | `retryQueuedCaptures` 以 `alreadyStored` 文本相同即 `markAcknowledged` 并删记录；`normalizeCapture` 白名单还把 `turnKey` 丢弃，使记录退化为“无 key 历史记录” | 队列记录**强制 turnKey**（state-store 序列化保留）；只有该 key 的 durable ACK 才自动出队；unknown 只报告 `suspected` 不升级不删除；无 key 历史记录保留待处理；`definitely_not_sent` 恢复后真实重发 | `test/r3-spool.test.mjs` SA1（同内容不同 turn 两组都写）/SA2（unknown 不重发不自动 ACK）/SA3（legacy 保留） |
| **B. ECONNABORTED 误分类** | `NOT_SENT_CODES` 含 `ECONNABORTED`，连接中断被判“肯定未送达”→ 可能重复写入 | 集合收敛为连接建立前失败（`ECONNREFUSED/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/ENETUNREACH`）；无法证明未送达一律 `maybe_sent`→unknown | `test/delivery.test.mjs` DB-R1–R4（ECONNABORTED/复合 cause→maybe_sent；ENOTFOUND/ECONNREFUSED→definitely_not_sent） |
| **C. 跨进程旧状态覆盖** | `#persist` 整张内存 Map merge-on-write，旧进程的 stale pending 可覆盖他进程新落盘的 acknowledged；状态文件损坏被当空库继续发送 | 只合并**本进程 dirtyKeys**；终态（acknowledged/denied/unknown）永不被非终态回退（终态间按秩）；非 dirty key 用磁盘终态刷新内存；解析失败（非 ENOENT）→ `corrupted` → execute 一律 `deferred` | `test/r3-crossproc.test.mjs` DC-R1（陈旧 pending 不覆盖 acknowledged——修复前实测复现）/DC-R2（unknown 不被 sending 回退）/DC-R3（损坏文件 fail-closed）/DC-R4（磁盘不可写降级） |

## 2. M2 防回退：严格部署门禁

`ops/loopback-guard.sh`（重写为严格门禁）+ `ops/test/loopback-guard.test.mjs`（11 个 mock-docker 用例）：

| 旧 guard 误报 | 新行为 |
| --- | --- |
| 容器无端口发布也说 OK | **FAIL**（missing required port） |
| 启动脚本缺失被跳过 | **FAIL**（无法验证未来部署） |
| grep 文本匹配（注释假命中） | 解析实际 `-p` 参数（排除 `mkdir -p` 误命中），必须 loopback |
| 容器 stopped 也 OK | **FAIL**（not running / health 非 healthy） |
| 错误 override 无感 | **FAIL**（`MEMORY_*_HOST_BIND` 非 loopback） |
| 额外端口无感 | **FAIL**（未批准额外端口；`APPROVED_EXTRA_PORTS` 显式批准才放行） |

当前对**真实生产**运行：`GUARD PASS`（四端口 loopback、容器 healthy、三脚本 loopback 默认）。
可复现入口：`ops/loopback-guard.sh [deploy-dir]`，退出码 0/1/2。

## 3. M3 Proxy Bearer 兼容（隔离验证）

**审计结论**：Proxy 对 Core 的全部调用中，`tdai/client.ts`、`skill/*`、`knowledge/*`、Hub/Panel 侧均已发送 `Authorization: Bearer <serviceToken>`；**唯一缺口是 `auth.ts:verifyUserKey`**（只发 content-type + service-id）。

**修复**（3 文件，手术式）：
- `types.ts`：`AuthConfig.serviceBearer?: string`（仅服务级凭据，明文注释禁止冒充 user_key/上游 key）
- `config.ts`：`serviceBearer: yaml.auth?.serviceBearer ?? yaml.tdai?.apiKey ?? ""`（缺省复用本地部署中与 Core 一致的服务密钥，不新增凭据）
- `auth.ts`：verify 请求按条件加 `Authorization`；`initAuth` 在 enabled 但无 serviceBearer 时**高可见 WARN**（不静默降级）

**隔离 E2E**（`ops/e2e/run-r3-security-e2e.sh` 一键复现；强 Bearer Core + 合成用户 + 挂载源码到生产代理镜像运行）：

| 场景 | 结果 |
| --- | --- |
| 强 Bearer Core 拒错/缺 Bearer | 401 ✓ |
| **RED**：未打补丁 proxy + 有效 user key | **401 auth service returned HTTP 401**（复现官方脚本警告的兼容性问题） |
| **GREEN**：已 Patch proxy + 正确服务 Bearer | **200，上游到达** |
| 负向：错误服务 Bearer | 401（不静默降级） |
| 负向：缺失 user key | 401（missing user_key） |
| 负向：错误 user key | 401（invalid user_key） |

## 4. M4 服务端 scoped 身份：**架构 Hard Gate（未实施）**

隔离 Core（强 Bearer + 合成用户/team/agent）实测五类越权，`ops/e2e/scoped-identity-probe.mjs`：

| 场景 | 结果 |
| --- | --- |
| S1 有效服务 Bearer + 缺 user-key + body 伪造身份（读） | **allowed（200）** |
| S2 伪造 user_id（key 属 A、body 写 B）读 | **allowed（200）** |
| S3 非成员 team 读 | **allowed（200，空结果但非授权拒绝）** |
| S4 未授权 agent 读 | **allowed（200）** |
| S5 伪造身份写 L0 | **allowed（200）且落库**（隔离库 jsonl 实证） |

**判定**：Core v3 数据面不校验 `x-tdai-user-key` 与 body 身份的所有权关系——服务级 Bearer 不等于用户 ACL。修复需在 Core 引入 opt-in `scopedAuthEnabled`（user-key→principal→team/agent 归属校验，body 身份仅作授权后的选择），**改变现有 metadata 权限语义**，属上游架构变更。按指令 STOP 在架构门，仅交付隔离证据与最小兼容方案（见 PROD-AUTH-ROLLOUT.md §4）。**未迁移任何 schema、未改生产。**

## 5. 测试与证据总览

```
integrations/agent-memory  → 21 套 / 130 断言全绿（含 R3 新增 r3-spool / r3-crossproc / delivery R3 pins）
ops/test/loopback-guard    → 11 mock-docker 用例全绿；真实生产 GUARD PASS
ops/e2e/run-r3-security-e2e.sh → 隔离全栈：强 Bearer/RED/GREEN/三负向/M4 五越权，全部符合预期
生产健康                  → 四端口仍 127.0.0.1；三容器 healthy；未重启、未换镜像
```

## 6. 残余风险（诚实披露）

1. **服务端身份绑定缺口**（M4）：loopback 收敛只防 LAN，不防本机进程伪造身份；需上游架构变更。
2. **无服务端幂等键**：客户端三重机制（dirtyKeys 持久化 + 跨进程锁 + 读回疑似判重）为 best-effort，不宣称全局 exactly-once。
3. **Proxy serviceBearer 缺省值**：复用 `tdai.apiKey`，本地部署二者同源；多环境部署应在 `auth.serviceBearer` 显式配置。
4. **isolated E2E 的执行方式**：以“挂载源码进生产代理镜像”运行新代码（镜像含 node22+tsx+依赖；Docker 构建因本机 apt/网络不可达未采用），镜像 digest 与挂载源码版本均已在脚本中固定，可复现。
5. **legacy spool 记录**（无 turnKey）：按 R3 契约永久保留不重发，需运维清理策略（当前生产 spool 实际无积压）。

## 7. 提交与边界

- 分支：`feat/gpt-am-r3-security-readiness`（未 merge、未动默认分支、未发上游 PR）
- 未做：生产变更、镜像重建部署、密钥轮换、Hook/Plugin 切换、记忆数据变动、Core/Hub/Proxy 重启
- **下一 Hard Gate（唯一）**：Gateway 强鉴权 + 服务端 scoped 身份绑定的生产启用审批（先修上游架构或接受风险，再按 PROD-AUTH-ROLLOUT.md 灰度）。
