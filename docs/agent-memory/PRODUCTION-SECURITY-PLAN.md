# PRODUCTION-SECURITY-PLAN — Gateway 加固与灰度（预案，**未执行**）

> GPT-AM-001-R2 · 状态：**只读核实 + 方案设计**。本文件不构成变更授权；
> 任何一步执行前需用户正式批准（Hard Gate）。

## 1. 风险核实结论（2026-10-11，只读实测）

| 检查项 | 实测结果 | 风险 |
| --- | --- | --- |
| Core 端口发布 | `8420/tcp → 0.0.0.0:8420`（IPv4+IPv6 全接口） | 任意可达 8420 的进程均可读写 |
| LAN 可达性 | `http://192.168.1.2:8420/health` → **200** | 局域网设备可直连 |
| 未授权读取（LAN，伪造身份、无 user-key） | `POST /v3/conversation/search` 带伪造 team/agent + 无 user-key → **返回真实 L0 数据** | **P0：非受信主机可读可写生产记忆** |
| Gateway 鉴权 | `auth=disabled`（legacy 兼容 Bearer，启动日志 WARN 明示） | 服务级 Bearer 未启用 |
| 容器内部路径 | `tdai-memory-stack` 网桥内 `memory-core:8420` 可达（proxy/hub 依赖） | 加固时**必须保留** |
| macOS 应用防火墙 | globalstate 读取无输出（疑似默认关） | 无主机层兜底 |
| 密钥明文外泄 | 本轮 grep 扫描只发现测试合成值；`.env` 600 权限 | 无新发现 |

**判定：满足 R2 指令的“立即 STOP 并报告”条件 → 未做任何生产改动。**

### 应急处置建议（立即，需用户决定）

1. 最短路径止血：`docker` 层面把 Core 端口改绑 loopback（`127.0.0.1:8420:8420`），
   或`TDAI_GATEWAY_API_KEY` 设强随机值并只让本机客户端持有；
2. 若暂时不能重启 Core：macOS 层用 `pf` 阻断 8420 的入站（需 root，用户执行）；
3. 上述任一操作都会中断当前 Proxy/Hub→Core 的 host.docker.internal 路径之外的连接？
   ——不会：容器间走 `tdai-memory-stack` 网桥（`memory-core:8420`），与 host-port 绑定无关；
   但 Hub 的 `KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:8424` 经 host 回环，
   绑 loopback 后仍可用。**仍需按 §3 步骤逐层验证**。

## 2. 威胁模型

| 场景 | 威胁 | 必要控制 |
| --- | --- | --- |
| 单用户受信主机（当前） | LAN 内其他设备/恶意进程读写记忆 | loopback 绑定 + 强 Bearer（两层都要，不能只做其一） |
| 多用户共享部署 | 用户 A 伪造 team/agent 读用户 B | 服务端 user-key→user_id→team/agent 授权；非法身份 403/404 且不泄数据 |
| 插件/Hook 客户端 | 客户端配置被读后滥用 key | key 仅入 0600 文件；最小权限（服务级 Bearer 不等于用户 ACL） |

## 3. 分阶段加固（按序执行，每步可回滚）

**阶段 0（准备，隔离环境验证）**
1. 在 R2 worktree 用 `am001-e2e-core`（loopback + 强 key）复现全部 E2E gate，
   证明加固后四客户端功能不退化；
2. 准备回滚脚本（恢复 `.env`/compose/容器参数）与变更窗口。

**阶段 1（止血）**
1. 停 Core 前确认无进行中的 capture（`docker logs tdai-proxy` 无 in-flight）；
2. 改 `.env`：`MEMORY_CORE_GATEWAY_API_KEY=<强随机>`；compose/脚本端口
   `127.0.0.1:8420:8420`；
3. 重启 **仅 Core**（Hub/Proxy 不动）；
4. 逐层健康检查：core `/health`（loopback）→ hub `:8125` → proxy `:8096`
   → 一条真实 recall/anthropic 转发 → LAN 侧确认 8420 拒绝；
5. 同步更新 `integrations/agent-memory/config.local.json` 的 `apiKey`
   （四客户端共用），重跑 doctor。

**阶段 2（身份绑定，需上游支持）**
1. Gateway 将 `x-tdai-user-key` 绑定 user_id，校验 team/agent 归属，
   body 伪造身份一律 403/404（不返回数据）；
2. 隔离实例先验：错误 key / 伪造 team / 缺失 key 三类用例全部拒绝；
3. 通过后再切生产。

**阶段 3（灰度接入）**
1. OpenCode 单会话 → codex 单会话 → claude/zcode；
2. 每级观察 recall/capture 指标与 L0 增长曲线；
3. 任一级异常：停该客户端 hook（install-hooks uninstall）即可回退，不影响其他端。

## 4. Docker 网络图（加固后）

```text
host 127.0.0.1:8420 ──► tdai-memory-core:8420   (loopback only)
                    └─X  LAN 192.168.1.2:8420   (阻断)
tdai-memory-stack 网桥内：
  tdai-memory-hub  ──► memory-core:8420 (v3)
  tdai-proxy       ──► memory-core:8420 (v3)
  tdai-memory-core ──► （无出站依赖，除 LLM 上游）
host.docker.internal:8424 ← hub KNOWLEDGE_PUBLIC_BASE_URL（不受 loopback 影响）
```

## 5. 回滚

- 阶段 1 回滚：恢复端口 `0.0.0.0:8420`、清空 `MEMORY_CORE_GATEWAY_API_KEY`、重启 Core；
- 阶段 3 回滚：`node src/install-hooks.mjs uninstall` 逐客户端摘除；
- 回滚演练脚本与验证命令随变更单提供，**只在隔离环境演练**。

## 6. 与 #1631 的关系说明（勘误）

上游 Issue #1631 截至 2026-10-11 **评论数为 0**（API 实测）。ZCODE-AM-001 报告中
“对应官方 Issue #1631 评论中的 D 项”表述有误——该验收项出自本地 R2 评审，并非上游
评论。特此更正；对上游的提案仍以 #1631 正文为准。
