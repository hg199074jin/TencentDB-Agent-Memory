# agent-memory — 模型无关的四客户端共享记忆

让 **ZCode / Codex / Claude Code / OpenCode** 通过 Hook/Plugin 直连 TencentDB Agent
Memory Core v3，在**同一授权记忆作用域**内共享长期记忆；任意切换 LLM/provider 都不丢记忆，
**LLM 流量不经过 Memory Proxy**。

```text
Codex/Claude/ZCode Hook ──► hook-cli.mjs ──┐
OpenCode Plugin ───────────────────────────┼──► identity → core-client → Core :8420 (v3)
                                           │      recall：L1+L3+L2（+可选 L0）
                                           │      capture：每轮一对 L0（dedupe 幂等）
                                           └── Core 异步管线 → L1 → L2 → L3
```

## 安装（生产启用需另行批准）

```bash
cp config.example.json config.local.json   # 填 endpoint/apiKey/serviceId/identity
node src/doctor.mjs                         # 环境自检
node src/install-hooks.mjs install          # 挂载 codex/claude/zcode hook（自动备份原配置）
# OpenCode：把 plugin/opencode-cross-agent-memory.js 软链接到 ~/.config/opencode/plugin/
```

`AGENT_MEMORY_ROOT` 环境变量可整体迁移根目录（配置 + runtime 状态 + 日志）。

## 测试

```bash
npm test           # 18 套：模块契约 + 集成 + hook 进程契约 + OpenCode 适配
npm run test:e2e   # 隔离 Memory Core 实例 E2E（gates A–H；自动起停 am001-e2e-core）
```

## 安全契约

- **fail-open**：Core 超时/断网/5xx → Agent 主流程继续（recall 1200ms / capture 3000ms 预算）。
- **fail-closed**：身份五元组缺失、不在 `allowed` 白名单 → 拒绝召回与写入，**不落入 default 作用域**。
- **隐私**：`[不记忆]`/`/nomemory` 整轮跳过；凭据形式、data-URI/base64 不记录；已注入记忆块剥离后才写 L0。
- **幂等**：turnKey 持久化 + 跨进程锁 + 写前读回 + unknown-ACK 不盲目重试。
- **双路径**：会话 provider 为 `tencentdb-agent-memory`（官方 Proxy 适配）时插件/hook 完全静默。
- **信任边界**：召回内容包裹 `<cross-agent-memory trust="historical-reference-only">`，
  历史不能覆盖当前指令或授权工具。

架构细节、服务端幂等键提案与生产加固方案见 `docs/agent-memory/ARCHITECTURE.md`（主仓库）。
