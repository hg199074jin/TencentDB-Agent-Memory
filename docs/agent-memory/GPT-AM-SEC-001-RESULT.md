# GPT-AM-SEC-001-RESULT｜Stage 1 生产安全止血 — 验收报告

- **Verdict：`PASS`**（宿主机 LAN 暴露已关闭；Hub/Proxy 实际功能经网桥验证正常；未启用强 Bearer、未动 Hook/Plugin、未动数据）
- 执行时间：2026-10-11（容器重建 + 端口绑定变更，Hub/Proxy 未重启）
- 授权范围：仅将 Mac 宿主机 Core 端口发布限制为 `127.0.0.1:8420`（用户明确批准）
- 分支：`feat/gpt-am-sec-001-containment`（本人 Fork）

## 1. 操作前状态（P0 只读核对）

| 项 | 值 |
| --- | --- |
| Core 镜像 | `sha256:338847edc646…`（与 E2E 固定 digest 一致，**未更换、未 pull**） |
| host 发布 | `8420/tcp → 0.0.0.0:8420` + `[::]:8420`（**暴露面**） |
| LAN 可达（操作前实测） | `192.168.1.2:8420` → 200；伪造身份、无 user-key 可读真实 L0 |
| 重启策略 | `no` |
| 数据卷 | `tdai-memory-core-data`（+ gateway config 只读绑定） |
| 网络 | `tdai-memory-stack`，别名 `memory-core`，容器 IP 172.18.0.4 |
| Hub→Core | `REMOTE_INSTANCE_URL=http://memory-core:8420`（网桥别名） |
| Proxy→Core | `endpoint: http://memory-core:8420`（网桥别名） |
| Entrypoint/Cmd | `[tini --] node --import tsx src/gateway/server.ts` |

**结论**：Hub/Proxy 均经网桥别名访问 Core，与宿主机端口发布方式无关——这是 Stage 1 只改 host bind 不影响内部链路的前提。

## 2. 隔离演练（P0，未触生产）

| 演练项 | 结果 |
| --- | --- |
| `-p 127.0.0.1:18420:8420` 发布 | host loopback 200；`PortBindings.HostIp=127.0.0.1`（无 `[::]` 残留） |
| LAN 192.168.1.2:18420 | **拒绝** |
| 网桥别名 `memory-core:8420`（另一容器内 fetch） | **200**（容器内仍 `0.0.0.0` 监听） |
| 清理 | probe 容器/网络/卷已删除 |

## 3. Stage 1 变更（P1，唯一生产变更）

可逆容器替换：**仅**将 host publish 由 `0.0.0.0:8420` 改为 `127.0.0.1:8420:8420`；
镜像 digest、数据卷、gateway config 绑定、网络与别名、全部环境变量、Entrypoint 均逐项保持一致
（env 经 0600 临时文件传递，未打印任何密钥）。

同时已对持久化配置打补丁（防止下次 `start-memory-core.sh` 自动重新暴露）：
`deploy/global-images/start-memory-core.sh:207` → `-p "${MEMORY_CORE_HOST_BIND:-127.0.0.1}:${MEMORY_CORE_PORT}:8420"`
（保留该文件既有 staged 改动；可用环境变量显式覆盖）。shellcheck 通过。

## 4. 依序验收结果

| 验收项 | 证据 | 结论 |
| --- | --- | --- |
| host publish 仅 127.0.0.1 | `docker port` → `8420/tcp -> 127.0.0.1:8420`；`PortBindings` 无 `0.0.0.0`/`::` | ✅ |
| host loopback | `/health` → 200；带 user-key 的授权读回合成标记 `code:0` | ✅ |
| Hub/Proxy 未重启 | uptime 连续 5 小时+（非本容器生命周期） | ✅ |
| Proxy 实际 auth/session-init/injection | 真实请求日志：`session-init … justRegistered=true`、`injection-debug … hasAgentDetail=true hasAgentDetail=true`、LLM 正常返回 | ✅ |
| Hub 实际调用 | `8424/v3` 有响应（需鉴权 401），hub 日志无 core 连接错误 | ✅ |
| 生产 Hook 客户端读路径 | `hook-cli.mjs codex` UserPromptSubmit 返回 `additionalContext`（召回正常） | ✅ |
| LAN 拒绝 | `192.168.1.2:8420` → 连接拒绝（HTTP 层不可达，非 4xx） | ✅ |
| 镜像/卷一致性 | digest 与操作前一致；`tdai-memory-core-data` 原卷原挂载点 | ✅ |

**LAN 验证方式说明**：从本机经 LAN IP `192.168.1.2` 探测（连接被拒即证明 publish bind 已收紧）。未使用独立第二台设备（不可用）；隔离演练中 `127.0.0.1` 成功/LAN 拒绝的对照已覆盖同一语义。

## 5. 预先存在的无关故障（非本次引入）

`tdai-proxy` 的 `CREDIT_REPORT … fetch failed` 在止血前日志（2026-10-10 16:49）即存在，
与端口变更无关；本阶段不处理（Proxy 侧 credit 上报端点问题，另行排查）。

## 6. 残余风险（只读记录，**未**在授权内修改）

| 端口 | 属主 | LAN 实测 | 说明 |
| --- | --- | --- | --- |
| 8125 | Memory Hub 面板 | **200（LAN 可达）** | 面板含团队/资产数据，建议下一阶段绑 loopback |
| 8424 | Memory Hub Knowledge API | LAN 可达（404 on `/`） | 需鉴权，仍应绑定 |
| 8096 | Memory Proxy | LAN 可达（404 on `/`） | LLM 代理入口，建议绑 loopback + 强 key |

注：8420 从 IPv4+IPv6 全接口收敛为仅 IPv4 loopback；`[::1]`（IPv6 本机）未发布，本机使用不受影响。

## 7. 明确未完成项（不属于 Stage 1）

- **未启用 Gateway 强 Bearer**——上游 `MemoryProxy/src/auth.ts` 的 `/v3/meta/auth/verify` 不带 Authorization（上游启动脚本 22–34 行有明示），单开强 Bearer 会阻断 Proxy 登录/session-init；须先修 Proxy Bearer 传递（Stage 2）。
- **未做服务端 user-key→身份绑定**：Mac 本机任意进程仍可经 loopback + 伪造身份访问 Core（网络层已收敛，授权层未收敛）。
- R2 代码未投产；R3 剩余项（spool 内容匹配误去重、`ECONNABORTED` 归类）按用户排期处理。

## 8. 回滚（仅批准时使用）

`/tmp/amsec-rollback.sh`（0700，不含密钥，env 从 0600 文件读取）可将 Core 恢复为
`0.0.0.0:8420`。**该状态重新暴露 LAN，属危险态，仅在整个系统故障且获得用户明确批准时使用。**

## 9. 结论

Stage 1 达成且仅达成一个目标：**局域网设备无法再访问生产 Memory Core**。
原有镜像、数据卷、记忆记录、容器间网络、Hub/Proxy 运行状态均保持原样。
下一生产 Hard Gate：Hub(8125/8424) 与 Proxy(8096) 的 loopback 收敛、Proxy Bearer 修复、
Gateway 强鉴权与服务端身份绑定、四端灰度。
