# GPT-AM-SEC-002-RESULT｜8125 / 8424 / 8096 宿主机端口收敛 — 验收报告

- **Verdict：`PASS`**（三端口宿主机发布全部收敛至 `127.0.0.1`；Hub/Proxy 经网桥的真实业务链路实测正常；8420 Stage 1 成果保持不变）
- 执行时间：2026-10-11；授权：用户明确批准 GPT-AM-SEC-002 Stage 1B（仅宿主机端口收敛）
- 分支：`feat/gpt-am-sec-002-containment`（本人 Fork）

## 1. Before / After（四端口 publish）

| 端口 | 容器 | Before | After |
| --- | --- | --- | --- |
| 8420 | tdai-memory-core | ~~0.0.0.0 + [::]~~ | **127.0.0.1**（Stage 1 保持，未回退） |
| 8125 | tdai-memory-hub | 0.0.0.0 + [::] | **127.0.0.1** |
| 8424 | tdai-memory-hub | 0.0.0.0 + [::] | **127.0.0.1** |
| 8096 | tdai-proxy | 0.0.0.0 + [::] | **127.0.0.1** |

`docker inspect PortBindings` 四项均只有 `HostIp=127.0.0.1`，无 `0.0.0.0`/`::` 残留（IPv4/IPv6 双栈均已收敛）。

## 2. M0 只读核对关键结论

| 核查项 | 结论 |
| --- | --- |
| Hub/Proxy → Core 路径 | 均走网桥别名 `memory-core:8420`（Hub `REMOTE_INSTANCE_URL`、Proxy `tdai.endpoint`），与 host publish 无关 |
| `host.docker.internal:8424` 依赖 | **无实际消费方**：Core 的 `/v3/knowledge/*` 仅本机 sqlite CRUD（无内容转发）；Proxy 知识注入器调 Core（`:8420`）；Hub 日志中容器间调用均为网桥 IP/别名（实证：`172.18.0.3:8096` 直连）；Mac 本机无法解析 `host.docker.internal`（浏览器/面板不走该地址） |
| 知识服务鉴权 | 写/管理端点需 `KNOWLEDGE_SERVICE_KEY` Bearer；只读白名单（`/tools/list`、`/tools/call`、`/wiki/*`、`/graph` 等）**设计上无鉴权开放**——这正是 8424 LAN 暴露的真实风险（未授权可读 wiki），收敛后消除 |
| 外部活动连接 | `netstat` 对 8125/8424/8096 **无任何非 loopback 活动连接**；四客户端配置（codex/claude/zcode/opencode）无 LAN IP 引用；opencode provider baseURL 为 `127.0.0.1:8096` |
| 容器规格 | Hub `sha256:070cb868…`（user 默认、`--add-host`、卷 `tdai-panel-data`）；Proxy `sha256:82df81d8…`（`--user app`、config 只读挂载）——替换时逐项复刻 |

## 3. M1 隔离演练（未触生产）

| 演练 | 结果 |
| --- | --- |
| Hub 双端口 `127.0.0.1:18125/18424` | loopback：18125→200、18424→401（鉴权生效）；LAN：均拒绝；绑定仅 127.0.0.1；网桥别名 `memory-hub:8125/8424` 探针容器可达（200/401） |
| Proxy `127.0.0.1:18096` | loopback→200；LAN 拒绝；绑定仅 127.0.0.1；别名 `proxy:8096` 可达 |
| 结论 | host bind 收敛不影响容器内 0.0.0.0 监听与网桥互访——与生产变更结果一致 |

## 4. M2 生产变更（两个容器依次可逆替换，仅改 host publish）

1. **Hub**：`docker rm -f tdai-memory-hub` 后以**原镜像 digest、原卷 `tdai-panel-data`、原网络/别名、原 `--add-host`、原全部 env（0600 临时文件传递，已碎纸）**重建，仅 `-p 127.0.0.1:8125:8125 -p 127.0.0.1:8424:8424`。重建后 healthy。
2. **Proxy**：同法（`--user app`、config 挂载、env 一致），仅 `-p 127.0.0.1:8096:8096`。重建后 healthy。
3. Core 未做任何操作（Stage 1 绑定原样）。

## 5. 依序功能验收（真实业务路径，非仅 health）

| 验收项 | 证据 | 结论 |
| --- | --- | --- |
| loopback 全端口 | 8125→200、8424→401（鉴权）、8096→200、8420→200 | ✅ |
| **LAN 全端口拒绝** | 192.168.1.2:8125/8424/8096/8420 均连接拒绝 | ✅ |
| Proxy auth/sessionInit/injection/LLM 转发 | 真实请求：`session-init … justRegistered=true`、`injection-debug … hasAgentDetail=true`、GLM 正常返回 | ✅ |
| Hub sessionInit control plane | Proxy 经网桥调 hub 成功（上一行同请求）

 |
| 生产 Hook 客户端 | `hook-cli.mjs codex` UserPromptSubmit 返回 `additionalContext`（召回正常） | ✅ |
| Knowledge 只读白名单 | loopback `POST /v3/tools/list` 到达业务校验（400 knowledge_id required = 端点存活且处理） | ✅ |
| 8420 不变量 | `docker port tdai-memory-core` 仍仅 `127.0.0.1:8420` | ✅ |
| 既有 CREDIT_REPORT 故障 | Stage 1 已记录为预先存在，与本轮无关 | — |

## 6. 持久化与防回退

- `start-memory-core.sh`（Stage 1 补丁保持）、`start-memory-hub.sh`、`start-proxy.sh` 三脚本的 host publish 默认值均已改为 `127.0.0.1`（分别可用 `MEMORY_CORE_HOST_BIND` / `MEMORY_HUB_HOST_BIND` / `MEMORY_PROXY_HOST_BIND` 显式覆盖）；保留全部既有 staged 改动；shellcheck 0 error/0 warning。
- 统一 guard：`ops/loopback-guard.sh`（只读）——核对四容器端口绑定 + 三脚本 drift；当前输出 `GUARD PASS`（exit 0）。部署前后各跑一次即可发现回退。
- 已知 drift 面：**上游官方脚本与 Fork 旧默认分支仍是全接口发布**；从其他未打补丁的工作树部署会重新暴露。guard 的脚本检查可发现此类 drift，但无法阻止他人直接 `docker run`。彻底解决需要把补丁合入部署源（属下一审批）。

## 7. 明确未做（不属于本阶段）

- 未启用 Gateway 强 Bearer、未修 Proxy `auth.ts` Bearer 传递（上游兼容问题，单独阶段）；
- 未做服务端 user-key→身份绑定（loopback 收敛≠授权收敛：**Mac 本机任意进程仍可经 127.0.0.1 + 伪造身份访问**）；
- 未动 Hook/Plugin、镜像、数据卷、记忆数据、模型路由；
- 未从第二台独立 LAN 设备复测（不可用）：以本机经 LAN IP `192.168.1.2` 连接被拒 + `PortBindings` 证据替代，局限性如实记录。

## 8. 回滚边界

回滚只能回到**仍为 loopback-only** 的安全配置（例如只回滚某个容器的其他参数）。若业务故障必须恢复 LAN 开放，须用户单独批准并先部署防火墙阻断——本阶段未产生此类需求（验收全部通过）。

## 9. 结论与下一 Hard Gate

Stage 1B 达成：**8125 / 8424 / 8096 / 8420 四个宿主机端口全部仅本机可达**，业务功能经网桥实证正常。
下一生产 Hard Gate（均需单独审批）：Proxy Bearer 传递修复 → Gateway 强鉴权 → 服务端 scoped 身份绑定 → R3 代码收口 → 四端灰度。
