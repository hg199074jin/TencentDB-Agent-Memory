# PROD-AUTH-ROLLOUT — Gateway 强鉴权与服务端身份绑定上线预案（**仅预案，未执行**）

> GPT-AM-R3 交付物。本文件不构成生产授权；任何一步执行前需用户正式批准。
> 前置事实：四端口已 loopback（SEC-001/002）；Proxy `verifyUserKey` 已隔离修复（R3）；
> Core 数据面身份绑定缺口已在隔离环境实证（R3 M4）。

## 1. 目标与顺序

```text
阶段 0（已完成，隔离）  R3 修复 + 门禁 + Proxy Bearer 兼容 + 越权证据
阶段 1  部署侧密钥联通      Core/Hub/Proxy 三处 service key 一致，仍关闭强 Bearer
阶段 2  启用强 Bearer       仅 Core 开 TDAI_GATEWAY_API_KEY；Proxy 已带 Bearer
阶段 3  服务端身份绑定      需要上游 scopedAuthEnabled（架构门）或接受残余风险
阶段 4  四端灰度             逐客户端观察，异常可单独摘除
```

**铁律**：任一步失败，回到上一步的安全状态；不得为恢复功能而重开 LAN 或关闭鉴权。

## 2. 密钥与联动（阶段 1–2）

| 组件 | 需要持有的凭据 | 当前状态 | 目标 |
| --- | --- | --- | --- |
| Memory Core | `TDAI_GATEWAY_API_KEY`（服务级） | 空（auth disabled） | 设强随机值（32+ 字节） |
| Memory Proxy | `auth.serviceBearer`（缺省 `tdai.apiKey`） | `tdai.apiKey=local` | 与 Core 同值；R3 补丁后 verify 自动携带 |
| Memory Hub | `REMOTE_INSTANCE_KEY` | `local` | 与 Core 同值（Hub→Core 已具备 Bearer 能力） |
| 合成 Hook 客户端 | 同一服务 Bearer | 本地配置 | 同值（本机 loopback） |

密钥分发：只入 `deploy/global-images/.env`（0600）与容器环境；不提交 Git、不进日志。
轮换：Core 轮换 → 同步 Proxy/Hub/hook → 逐组件重启验证；保留旧 key 5 分钟重叠期不可行
（Core 单 key 模型），故轮换窗口内短时拒绝属预期，需预公告。

## 3. 升级顺序与不同步重启风险

1. **预检**：`ops/loopback-guard.sh` PASS；`verify.sh` 全绿；四客户端当前无进行中会话。
2. **阶段 1**（不启用强 Bearer）：三处 service key 先同值（如 `local`→同一新值但 Core 仍留空？——
   不可：Core 留空则任何 Bearer 都通过（`if (!expected) return "ok"`），无验证意义但**无害**；
   此阶段目的是让 Proxy/Hub 的 Bearer 发送路径在“Core 不校验”下先跑通，避免阶段 2 双变量）。
   - 操作：Proxy/Hub 配置更新 + 各自重启；Core 不动。
   - 验证：Proxy 真实请求 200；Hub 面板/Knowledge 正常；`docker logs` 无 401。
3. **阶段 2**（启用强 Bearer）：仅 Core 加 `TDAI_GATEWAY_API_KEY` 并重启。
   - 风险：若 Proxy/Hub 未带正确 Bearer → auth/verify 401 → **Proxy 登录/session-init 全失败**。
   - 验证顺序：Core `/health`（无 Bearer 应 200）→ 带 Bearer 的 `/v3/core/read` 200 →
     Proxy 一条真实请求 200（这条不过则立即回滚阶段 2）→ Hub 面板 200 → hook recall 正常。
   - **不同步重启风险**：Core 先启强 Bearer 而 Hub/Proxy 后配置 → Hub 知识 ingest 失败、
     Proxy 401；因此阶段 1 必须先完成并验证。反向（Proxy 先带 Bearer、Core 后开）无害
     （Core 不校验阶段多出的头被忽略）。
4. **阶段 3**（服务端身份绑定）：依赖上游 `scopedAuthEnabled`；落地前维持
   “loopback + 服务 Bearer”双控，并在文档明示“本机任意进程 + 服务 Bearer 仍可全域读写”。
5. **阶段 4**（四端灰度）：OpenCode（插件已在 R3 分支可切换）→ Codex → Claude → ZCode；
   每级观察 recall/capture 指标与 L0 增量；异常级摘除：`install-hooks.mjs uninstall`。

## 4. 服务端身份绑定最小兼容方案（阶段 3 提案，需上游）

```text
opt-in: gateway.scopedAuthEnabled = false（默认，完全兼容现有调用）
true 时：
  1. x-tdai-user-key 经 /v3/meta/auth/verify 解析为真实 user_id（principal）
  2. body/header 的 user_id/team_id/agent_id 仅允许是 principal 有权限的对象
     （team 成员关系 + agent ACL 由 metadata 层裁决）
  3. 不满足 → 403/404，不返回数据、不泄露存在性
  4. 内部高权限调用使用独立 service principal（显式 scope），
     禁止把所有持服务 Bearer 的 Hook 当作全域管理员
  5. 旧 v2/bridge 路由同步纳入或显式豁免并文档化
```

迁移影响：无 schema 变更（纯授权语义）；需要 metadata ACL 查询路径的压测
（每次数据面请求 +1 次成员校验，建议带 30s TTL 缓存）。

## 5. 安全回滚

| 阶段 | 回滚动作 | 回滚后安全状态 |
| --- | --- | --- |
| 1 | 恢复 Proxy/Hub 原配置并重启 | loopback + auth disabled（当前态） |
| 2 | Core 清空 `TDAI_GATEWAY_API_KEY` 重启 | 回到阶段 0（loopback 仍有效） |
| 3 | `scopedAuthEnabled=false` | 同阶段 2 |
| 4 | 逐客户端摘除 hook/plugin | 其余客户端不受影响 |

**任何回滚都不得把 host publish 改回 `0.0.0.0`**——那需要用户单独批准且必须先有防火墙阻断。

## 6. 验收清单（每阶段）

- [ ] `ops/loopback-guard.sh` PASS
- [ ] Core/Hub/Proxy `/health` 与真实业务路径（auth/verify、session-init、recall、ingest、模型流）
- [ ] `docker logs` 无新增 401/5xx
- [ ] 四端口 `docker port` 仍仅 127.0.0.1（阶段 2 后 Core 应表现为“无 Bearer 401/有 Bearer 200”）
- [ ] 生产 L0 计数无异常跳变（合成探针标记可检索）
