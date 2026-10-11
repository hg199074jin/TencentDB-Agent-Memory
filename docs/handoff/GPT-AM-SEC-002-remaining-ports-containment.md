# GPT-AM-SEC-002｜8125 / 8424 / 8096 局域网端口隔离（Stage 1B；需用户单独批准）

> **本文件不构成生产操作授权。** 仅当用户在本次独立阶段明确说出“批准执行 GPT-AM-SEC-002 Stage 1B”后，ZCode 可执行授权内的生产变更。否则只可只读核对/隔离演练/报告。上一次 Stage 1 的批准不能自动扩展至这三个端口。

## 0. 已核实的背景、原因和代码定位

- 上一阶段：[GPT-AM-SEC-001-RESULT](https://github.com/hg199074jin/TencentDB-Agent-Memory/blob/feat/gpt-am-sec-001-containment/docs/agent-memory/GPT-AM-SEC-001-RESULT.md)，Commit `13e91fcd`。已把**宿主机** Core 8420 从 `0.0.0.0` 改绑 `127.0.0.1`，不改变容器内部 `0.0.0.0`。安全成果必须作为本轮不可回退 invariant。
- 残余：Memory Hub `8125`（面板，LAN 200）；Memory Knowledge `8424`（LAN 可达，根路径404）；Memory Proxy `8096`（LAN 可达，根路径404）。LAN reachability 已核实，但**不能把单纯 HTTP 200/404 推定为所有 API 未授权读取**。应进行无敏感只读的鉴权配置审计，禁止复现对真实对话的数据泄露。
- 官方 `deploy/global-images/start-memory-hub.sh` Docker run 存在 `-p "${PANEL_PORT}:8125"` + `-p "${KNOWLEDGE_PORT}:8424"`；`start-proxy.sh` 存在 `-p "${PROXY_PORT}:8096"`；未来从未修补的仓库重启，会再次开放 LAN。
- **关键兼容风险（必须验证）**：官方 `deploy/global-images/.env.example` 将 `KNOWLEDGE_PUBLIC_BASE_URL` 默认设为 `http://host.docker.internal:8424/v3`，Knowledge 用它写入资源 `service_url` 供 Agent/Gateway 调 tools；host 8424 绑定 loopback 后，其他 Docker 容器访问 `host.docker.internal:8424` 可能失败。**优先评估 `http://memory-hub:8424/v3` 等网桥内可达的稳定服务地址**；该地址是否能被所有实际消费者访问、是否影响宿主机客户端或已存资源，需要先做隔离测试；不要未经验证直接改生产 URI。
- **Gateway 强 Bearer 单独阶段**：官方 `MemoryProxy/src/auth.ts:verifyUserKey` 调 `/v3/meta/auth/verify` 时缺 Authorization，`start-memory-core.sh` 明确警告 Core 先启强 Bearer 会破坏 Proxy auth/sessionInit。故本 Stage 1B **不启动强 Bearer、不改服务端 user-key ACL**。

## 1. 目标与权限

**最小、单一目标**：在保留现有业务功能和已完成 8420 防护下，确保宿主机 8125、8424、8096 只经 `127.0.0.1` 发布；网桥内部 Hub/Knowledge/Proxy 保持 `0.0.0.0` 服务监听以供容器互访。要检查 IPv6 和所有端口暴露路径。修复持久化**启动入口**，防止下次部署回退到全部接口。

用户明确批准时，允许：
- 只读 inventory/网络依赖追踪/合成隔离演练与受限备份；
- 依次可逆替换 `tdai-memory-hub` **一个容器**（其 8125 + 8424 共一个容器）以及 `tdai-proxy` **一个容器**，仅发布地址变化；如必须修复 Knowledge 公开 URL 的可达路径，限定于经过全部消费者验证的**非敏感 URL/路由配置**，并逐项展示差异；
- 更新原位 `start-memory-hub.sh` 和 `start-proxy.sh` 的 host port 默认发布地址至 `127.0.0.1`（用 `MEMORY_HUB_HOST_BIND`/`MEMORY_PROXY_HOST_BIND` 或统一明确命名），保留原生产 staged 修改，不进行 reset/clean；
- 验收，必要时**安全回滚**（不得恢复 0.0.0.0 未鉴权暴露）。
- 交付脱敏记录、独立功能分支/安全脚本，继续沿用一大里程碑连续执行。

**禁止**：重建/重启 Core、修改 Core 8420 安全绑定、修改生产记忆 L0/L1/L2/L3、镜像升级/docker pull `:latest`、任何数据卷删除、生产 database migration、开启 Gateway Bearer、改 Proxy 功能源码、新版 Hook/Plugin 上线、merge 或公开上游 PR。发现必须改这些才能保持业务，**Hard Gate STOP**。

## 2. M0 — 只读核对（对每项给出证据）

1. 读取当前 `docker inspect`（保留 image ID/digest、volume、环境变量**名字和功能性非秘密标志**、network alias、Entrypoint/Cmd、restart policy、host bind 与 health）、Hub/Proxy 实际启动脚本路径和 Git staged/dirty；**不打印 key、用户对话、模型 prompt**。
2. 再确认 8420 `127.0.0.1` 不变量；确认 8125、8424、8096 的 IPv4/IPv6 发布、独立 LAN 可达和来源（不是容器以外的另一进程）。
3. 查运行中的本机客户端是否依赖 LAN IP:8096；是否有其他电脑/手机/容器通过宿主 IP 或 `host.docker.internal:8096,8125,8424` 连接。**若用户确有远程终端访问需求或不明依赖，STOP 提交最小作用域方案，不直接收敛。**
4. 核实 `KNOWLEDGE_PUBLIC_BASE_URL` 的实际值及谁消费 `service_url`，Hub（Knowledge + Panel）、Core、Proxy、Mac host 的网络可达。比较 `host.docker.internal:8424/v3` 与 `memory-hub:8424/v3` 的实际访问。确认生产数据有没有持久化旧 URL（仅元数据/URL 聚合统计，不打印敏感资源）。如需要迁移数据库或重启 Core，则 STOP。
5. 逐项核实 Knowledge read-only 白名单可能对 LAN 无 Bearer 放行，Proxy 的 `auth.enabled` / 管理端 key，不得从根路径 404 判定安全。
6. 预期保留: Hub UI 登录、Panel 管理 API、Knowledge API `/v3/tools/*`/job callback、Core 内部调用/Knowledge toolbox、Proxy auth/session-init、LLM 正常转发、现役四端 Hooks（未切换到 R2）。
7. 产出可执行变更清单、无秘密备份、原镜像/卷保留演练；避免直接运行会隐式 `pull` / `rm` 其他容器的启动脚本。

## 3. M1 — 隔离演练（先 RED/再 GREEN）

在独立容器/测试网桥/合成数据模拟 Hub 双端口 + Proxy 单端口的 publish 改写：
- 仅 Host loopback 可以访问宿主端口，Mac LAN IP 拒绝；docker port/inspect 无 `0.0.0.0` 或 `::`。
- Hub+Proxy 容器内部仍监听 `0.0.0.0`；网桥别名 `memory-hub:8125`、`memory-hub:8424`、`proxy:8096` 可达；
- 所有使用 Knowledge `service_url` 的真实 consumer 路径支持拟议的内网 URL（Host 也可能需要直连——要明确谁能解析 Docker DNS）；
- Mock / isolated E2E 确保没有把 Core auth/sessionInit、知识工具注册和模型请求打断；
- 锁定版本 / 镜像 digest，验证失败时也能安全回滚，不污染/更改生产数据。

**任何关键消费者 URI 无法兼容或需要数据迁移，立即 STOP，并建议更小的 ACL/pf 防火墙边界作为替代计划（不自行执行）。**

## 4. M2 — 获得新授权才执行的生产改动

按依赖关系选择 Hub→Proxy 或 Proxy→Hub 次序，每次替换一个容器，**不能并行停机**：
1. 快照当前容器 runtime 规范（映像ID、命令、环境/数据卷、network alias、user、health、restart policy）；准备锁定镜像的独立 `docker run`/compose 持久化补丁，不运行默认可能自动更新镜像的脚本。
2. Hub：只把 host `8125,8424` 绑定 `127.0.0.1`，保留双进程 Knowledge/Panel 和容器内监听；仅在 M0/M1 证明必要且无迁移的情况下改**安全可回滚非秘密 URL 配置**。
3. Hub 验收合格后 Proxy：只将 host `8096` 绑定 `127.0.0.1`。不修改模型 provider/upstream url/api key，不切换客户端 hooks。
4. 确认四端实际连接路径、Host `8125/8424/8096` 功能、Core 8420 仍 localhost-only；Hub/Proxy 的 auth/sessionInit/Knowledge tools/LLM 转发**测试真实业务路径**，不能只测 health。
5. 验证 LAN 阻断：从真正另一台 LAN 设备优先；没有则 Mac 向 LAN IP 测试并注明证据局限；IPV4/IPv6 双栈端口无暴露。必要时补验 Docker Desktop 特殊路由。
6. 持久化 `start-memory-hub.sh` 和 `start-proxy.sh` 的 host bind 默认，并检查 `start-memory-core.sh` 的 Stage 1 补丁仍在（需要将四端安全端口发布形成一个统一、可重复的 installer/guard，而不是散落在未提交 staged 工作树中）。原 Fork 旧默认分支脚本可能仍是全接口绑定：提供可审计 Git patch + drift 检查 + 下次部署前 guard；确保没有在部署时对生产源码作 git reset/merge。
7. 回滚只能到仍 **localhost-only** 的安全配置；如果运行故障必须恢复 LAN 开放，须另行审批，不能自动解除隔离。
8. 一旦发现其他 P0 网络暴露，先报告 STOP，不越权追加端口。

## 5. 交付和 Hard Gate

报告：`docs/agent-memory/GPT-AM-SEC-002-RESULT.md`：
- 对比 publish 四端口 before/after；独立异机探测来源和限制；
- 全部容器的 image digest、volume、network/alias/Entrypoint、配置版本一致性；
- 关键 `KNOWLEDGE_PUBLIC_BASE_URL` 和 service_url 用户对话绝不写入报告；只报告域名/服务路由形态与测试结果，不抄 LLM 密钥；
- Hub UI/Knowledge read path + write/admin path（只用合成和已获授权的安全测试）、Proxy auth/sessionInit/Model stream、Core+Hooks 的实证；
- 工程 diff / commit / branch、生产配置安全持久化、回滚边界、未完成事项。

若无超范围的 Hard Gate，安全可回滚步骤允许一口气完成；完成后 STOP 于**Gateway Strong Bearer + Proxy auth 兼容修复 + server-side scoped identity + R3 代码审查 + 新四客户端灰度**，全部另行审批。

**注意：本文件没有授权生产执行。必须用户在新的消息里明确批准 GPT-AM-SEC-002 Stage 1B。**
