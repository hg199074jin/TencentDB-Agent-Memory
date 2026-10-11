# GPT-AM-SEC-001｜生产 Gateway 安全紧急止血（仅 Stage 1：宿主端口隔离）

**状态：已拟好执行单，未授权生产操作。** 本文件只是实施指令。ZCode **只能在用户的新消息明确写出“批准执行 GPT-AM-SEC-001 Stage 1 止血”时**按本文执行生产变更；若没有上述授权，限于只读检查、隔离演练和方案报告，STOP。**严禁由本文件自身或历史默认自动化授权推导生产批准。**

## 0. 关联证据与问题

- 生产事实来源：[ZCODE-AM-001-R2](https://github.com/hg199074jin/TencentDB-Agent-Memory/blob/feat/gpt-am-001-r2-safety/docs/agent-memory/ZCODE-AM-001-R2.md)、[原生产计划](https://github.com/hg199074jin/TencentDB-Agent-Memory/blob/feat/gpt-am-001-r2-safety/docs/agent-memory/PRODUCTION-SECURITY-PLAN.md)。
- ZCode 2026-10-11 现场发现：Core 发布 `0.0.0.0:8420`；LAN `192.168.1.2:8420` 可达；带伪造 team/agent/user 身份、缺真实 user-key 的请求已经读取真实 L0。作为 P0 真实安全缺口，立即限制可达范围。报告不需要再次展示历史 L0 明文。
- **独立审查发现原计划有兼容性阻塞**：上游 `deploy/global-images/start-memory-core.sh` 第22–34行明确警告，Proxy `/v3/meta/auth/verify` 缺少 Bearer；`MemoryProxy/src/auth.ts` 实际只发送 content-type 和 service-id（无 Authorization）。因此**不能**在不修 Proxy 的情况下只给 Core 打开强 Bearer。此发现优先级高于原 `PRODUCTION-SECURITY-PLAN.md` “loopback + 强 Bearer 同时做”的简化步骤。
- 上游启动脚本 `start-memory-core.sh` 当前 `-p "${MEMORY_CORE_PORT}:8420"`，即默认宿主全接口发布；容器内 `TDAI_GATEWAY_HOST=0.0.0.0` 才能保证容器间桥接访问。**本阶段只改宿主 Docker publish bind 为 127.0.0.1，不更改容器内 Gateway 的监听地址。**

## 1. 明确授权边界

**若用户仅授权 Stage 1**：
- 允许：只读核实、备份现运行容器/网络/volume 配置（不复制 L0 内容和密钥）、隔离模拟演练、在确认恢复方案后重建 **Memory Core 一个容器** 将 host port 从所有接口改成 `127.0.0.1:8420:8420`、相关持久化发布配置更新、非敏感健康检查和验证、必要时回滚到仍不暴露 LAN 的安全状态。
- 不允许：生成/轮换/启用生产 Gateway Bearer、不修改 Proxy/Hub 内部代码、不自动上线 R2 Hook/Plugin、不迁移/删除生产记忆、不更换镜像 digest、不 `docker pull latest`、不执行 `start-all.sh`/ `stop-all.sh --purge`、不 merge、不过问其他项目。
- 任何需进一步变更生产范围、存储/数据卷异常、发现启动命令不一致或无法可靠恢复、端口仍可从 LAN 访问的情况 → **STOP，报告已采取的措施和剩余风险，不假装止血成功**。

## 2. 逐步实施（批准后连续做，除 Hard Gate 不要求逐项确认）

### P0：先核对当前暴露面和操作计划

1. `docker ps --format ...`、`docker inspect tdai-memory-core`、`docker port tdai-memory-core`、`docker network inspect tdai-memory-stack`：得到当前 image **digest/ID**、entrypoint/cmd、环境变量**仅名称/必要非敏感标志**、volume 名和挂载路径、网络/aliases、restart policy、Core/Hub/Proxy 的健康值、端口映射；**绝不可打印 Bearer、用户 Key、LLM API Key，或真实记忆文本**。
2. 确认 Hub 和 Proxy 访问的是网桥别名 `memory-core:8420`（而不是通过宿主机 LAN IP）；检查另外的 `8125/8424/8096` 是否对 LAN 暴露，记录但**不扩大本次允许修改的范围**。
3. 检查 Core volumes 实际宿主来源、绑定脚本、启动参数；取配置文件带版本/哈希的本地权限受限备份；保留并锁住现有生产镜像 ID（绝不能悄然拉新 :latest），保证重建仍接原 volume、原环境（除端口映射）、原 gateway config、原 network。
4. 测试源脚本如果再次启动会不会恢复 `0.0.0.0` 发布。准备最小可审查持久化配置补丁或安全 wrapper，避免下次自动重启重新暴露 LAN。不得覆盖其他已 staged 的本地改动。
5. 在隔离容器/合成数据里演练 `127.0.0.1:18420:8420` 发布、仅容器内 `0.0.0.0` 监听、网桥 Hub/Proxy 同类访问；提前准备镜像固定、数据卷保留、失败恢复脚本。预计停机时长由本地演练实际测得，不作虚假零停机承诺。

### P1：Stage 1 网络止血

1. 用户已明确批准时，使用可逆容器替换方案，保留**原生产 Core 的 image ID、配置/环境、数据卷和网桥别名**；只将 Docker host publish 调整为 `127.0.0.1:8420:8420`。容器内部 `TDAI_GATEWAY_HOST=0.0.0.0` 不变。
2. **不要在本阶段启用强 Bearer**，因为 Proxy auth/verify 依赖代码目前不带 Authorization（原计划会导致 Proxy 登录/会话初始化受阻）。
3. 必须依序验收：
   - Docker port/inspect 证明 host publish 只绑定 `127.0.0.1`（检查 IPv4/IPv6；不能残留 `0.0.0.0`、`::` 对外发布）；
   - host loopback Core `/health` 正常，SDK 现有授权场景可正常读取**预先知道的合成/无敏感测试记录**；
   - `tdai-memory-hub` / `tdai-proxy` 未重新安装/重启（如必须重启另行升级 Hard Gate），其实际 auth/session-init/recall/knowledge 调用可用，不能只测 health；
   - 最少从**另一台独立 LAN 设备**或等价独立网络命名空间确认 TCP 8420 不可访问；`/health` 的 HTTP 失败不够，要区分 localhost 成功/LAN 拒绝；
   - 不对生产真实 L0 进行越权读取测试，不泄漏内容。
4. 失败时只恢复到**同样不对 LAN 公开的安全配置**；如果某项功能不能维持，优先保留网络隔离并将故障上报，不得默认恢复到 `0.0.0.0 + 无鉴权` 的危险状态。确需临时对 LAN 重新开放，必须独立获得用户批准、先部署有效防火墙阻断外部。
5. 变更后再次核对其它端口是否存在新的未鉴权外泄通路，只读记录；如证实立即 P0 升级 STOP。

### P2：即时证明与持久化

- 生成 `docs/agent-memory/GPT-AM-SEC-001-RESULT.md`（仅无秘密指标），包含操作前/后 redacted Docker inspect、镜像 image ID 与卷一致性、端口绑定、桥接访问证据、Host 和 LAN 探测、Proxy auth/verify 与 Hub 实际调用、现役 Hooks 未改变、隐私检查以及安全回退状态。
- 提交到本人 Fork 安全分支 `feat/gpt-am-sec-001-containment`；在 **Git 中只提交可脱敏的可复用脚本或文档**，不提交生产 `.env`、密钥、真实测试对话。若 Git 上传影响未知，则留本地完整证据并说明。
- 最终报告 `PASS/FAILED_PARTIAL/STOPPED`，并明确“Stage 1 仅解决 LAN 侧暴露，未完成服务端 user-key 身份绑定，未启用 Gateway 强 Bearer，Mac 本机不受信任进程仍是风险”。完整强鉴权属于单独下一审批。
- 阶段 2 单独隔离开发：修改 `MemoryProxy/src/auth.ts:verifyUserKey`，从受保护配置中向 Core `/v3/meta/auth/verify` 添加 Bearer，核对 Gateway 和 Hub 的其他调用、网络与密钥分发，在合成 E2E 验证后另行取得生产批准。**本 Stage 1 不执行。**

## 3. 不能忽略的 R2 正确性剩余项（只记录、勿混入止血）

- `integrations/agent-memory/src/capture.mjs:retryQueuedCaptures` 仍在 `alreadyStored` 内容相同的情况下调用 `markAcknowledged(via:"spool-read-back-suspected")` 且将队列项删除。这与不同 turn 但相同 user/assistant 应分别入库的要求有张力：需要独立 RED 用例证明 spool 不会误丢第二个真实 turn，后续 R3 纠正。
- `core-client.mjs` 的 `NOT_SENT_CODES` 包含 `ECONNABORTED`，它并非总能证明请求肯定没有发送。应在 R3 细化“可安全重试”归类；无法证明未送达应为 `maybe_sent`。此项只记录，Stage 1 不修改新客户端代码。
- 先止血，再完成 R3 correctness 收口、隔离验证、强 Bearer + Proxy 兼容、灰度启用。

**此文档不自动授权任何生产变更。仅在用户新消息明确“批准执行 GPT-AM-SEC-001 Stage 1 止血”时可执行 P0-P2。**
