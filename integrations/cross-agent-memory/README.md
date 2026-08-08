# 三个 AI 共用记忆：本机使用说明

这套小工具只做一件事：让 Codex、Claude Code 和 ZCode 在新会话里，共用你之后新产生的对话记忆和个人偏好。

它不会接管三个 AI 的模型连接：

- Codex 仍直连 OpenAI。
- Claude Code 仍按你原来的设置直连 MiniMax。
- ZCode 仍使用你当前的模型供应商。
- 三个模型请求都不经过 MemoryProxy。

## 它是怎样工作的

```text
模型线路（完全不变）

Codex ───────────────► OpenAI
Claude Code ─────────► MiniMax
ZCode ───────────────► 当前供应商

记忆线路（新增、独立）

Codex Hook ───┐
Claude Hook ──┼──► D 盘共享适配器 ──► MemoryCore :8420
ZCode Hook ───┘                              │
                                            └──► Memory Hub :8125
```

你提问时，Hook 会读取 L0 原始对话、L1 长期记忆和 L3 用户画像，作为明确标注的历史参考。回答结束后，只保存这一轮的用户问题和最终回答。系统提示、工具过程和中间内容不会被写入。

记忆线路发生故障时，三个 AI 仍会继续回答。写入失败的内容会先进入 D 盘队列，MemoryCore 恢复后再有限重试。

## 开始前确认三件事

1. 正式使用目录必须是 `D:\TencentDB-Agent-Memory`。不要把 Hook 指向 `.worktrees`、下载缓存或其他临时目录。
2. Docker Desktop 已启动，`tdai-memory-core` 正常运行；如果要看管理页面，再启动 `tdai-memory-hub`。
3. Node.js 版本不低于 22.16。运行 `node --version` 可以查看。

本地部署凭据应位于：

```text
D:\TencentDB-Agent-Memory\deploy\global-images\.admin-key
```

引导程序只读取这份现有凭据，不会在屏幕上显示它，也不会猜测或新造凭据。

## 第一次安装

请在 PowerShell 中依次执行。每一步成功后再执行下一步：

```powershell
Set-Location D:\TencentDB-Agent-Memory\integrations\cross-agent-memory
node src/bootstrap-config.mjs
node src/doctor.mjs
node src/install-hooks.mjs install
node src/doctor.mjs
```

各步骤的作用：

1. `bootstrap-config` 从现有本地部署读取 Gateway 地址和认证材料，写入固定的共用身份。
2. 第一次 `doctor` 检查 Node、配置、Gateway 以及 L0/L1/L3。
3. `install-hooks` 只给三个客户端增加两项记忆 Hook，并把原配置备份到 D 盘。
4. 第二次 `doctor` 再确认三个客户端都注册成功。

如果 `config.local.json` 已存在，引导程序默认不会覆盖。确实需要重建时使用：

```powershell
node src/bootstrap-config.mjs --force
```

使用 `--force` 前，原文件会先按原始字节备份到 `runtime\backups`。如果 Gateway 没启动，或者固定身份不被当前服务接受，引导程序会停止，不会写入半成品配置，也不要继续安装 Hook。

## 安装后还要做两件小事

### Codex

在 Codex 中运行 `/hooks`，按界面提示信任本地 Hook。客户端升级后如果 Hook 不执行，也先用 `/hooks` 检查信任状态。

### ZCode

安装后请新开一个 ZCode 会话。已经打开的旧会话可能仍使用安装前的配置。

Claude Code 不需要改模型地址；原有 MiniMax 环境变量和模型设置都会保留。

## 日常使用

正常聊天即可，不需要手动调用记忆工具。为了确认共享成功，可以先在一个 Agent 中说一条新的、非敏感偏好，等待该轮结束，再到另一个 Agent 的新会话中询问。

某一轮不想读取也不想保存记忆时，在用户消息中加入任意一个标记：

```text
[不记忆]
/nomemory
```

这一轮会同时跳过召回和写入。

不要把密码、API Key、Token 或私钥交给记忆系统。适配器发现常见凭据特征时会跳过整轮，但这只是第二道保护，不应代替你的谨慎操作。

## 查看记忆

Memory Hub 启动后，在浏览器打开：

[http://localhost:8125](http://localhost:8125)

这里主要用于查看 L0、L1 和 L3 是否已经产生。MVP 不使用 Skill、Wiki 或 CodeGraph。

## MemoryCore 暂停时会怎样

如果 MemoryCore 暂停或 Docker Desktop没有启动：

- 三个 AI 仍照常连接原模型并回答。
- 本轮没有召回内容时，Hook 会返回空结果。
- 已完成隐私过滤的待写入内容进入 D 盘队列。
- MemoryCore 恢复后，再触发一次回答结束 Hook，队列会在有限时间内自动补交。

本地状态都在正式目录下：

```text
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\logs\status.jsonl
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\pending-captures.jsonl
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\backups\
```

日志只记录状态和错误类别，不应包含完整对话或凭据。队列包含经过过滤的待补交对话，因此不要把 `runtime` 上传到 Git 或发给他人。

## 诊断命令

普通诊断不会写入测试对话：

```powershell
node src/doctor.mjs
```

它逐项显示 PASS 或 FAIL：配置、Node、Gateway、L0、L1、L3、可选写入状态，以及 Codex、Claude Code、ZCode 的 Hook 注册。

只有确实需要验证写入接口时，才运行：

```powershell
node src/doctor.mjs --write
```

该命令会写入一条固定的诊断记录，不包含你的真实对话。

## 卸载

卸载全部三个客户端的记忆 Hook：

```powershell
node src/install-hooks.mjs uninstall
```

只卸载某一个客户端：

```powershell
node src/install-hooks.mjs uninstall --client codex
node src/install-hooks.mjs uninstall --client claude
node src/install-hooks.mjs uninstall --client zcode
```

卸载只删除命令中明确指向本适配器的条目，不会删除原有模型、插件、MCP 或其他 Hook。

## 从备份恢复

每次安装或覆盖配置前，原文件会保存在：

```text
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\backups\<时间>\
```

里面按原目录结构保存以下文件中的一个或多个：

```text
.codex\hooks.json
.claude\settings.json
.zcode\cli\config.json
config.local.json
```

恢复时先退出对应客户端，再把最近一次操作前的备份复制回用户目录中的相同位置。不要混用不同时间目录里的文件。恢复后新开客户端，并再次运行 `node src/doctor.mjs`。

通常优先运行精确卸载即可；只有配置文件损坏或确实需要回到安装前原样时，才手动恢复备份。

## 仓库或客户端升级后

不要直接重装。先在正式目录运行固定回归：

```powershell
Set-Location D:\TencentDB-Agent-Memory\integrations\cross-agent-memory
npm test
node src/doctor.mjs
```

然后：

1. 各向 Codex、Claude Code、ZCode 的 Hook CLI 做一次离线烟雾检查。
2. 只做一次 Codex 到 ZCode 的真实跨端召回。
3. 若仅一个客户端失败，只卸载该客户端的 Hook，另外两个继续使用。
4. Codex 升级后再看 `/hooks` 信任状态；ZCode 升级或重装 Hook 后新开会话。

这套回归把半年内最容易变化的地方集中在 MemoryCore API、Hook 输入输出和三端配置格式。测试和诊断通过后，才重新安装或继续真实验收。

自动化测试为了避免接触真实配置，只在同时设置 `CROSS_AGENT_MEMORY_TEST_MODE=1` 时读取 `CROSS_AGENT_MEMORY_TEST_ADAPTER_ROOT` 和 `CROSS_AGENT_MEMORY_TEST_DEPLOY_DIR` 两个临时路径变量。它们只用于测试隔离、不承载凭据，日常使用不要设置。

## 本机验证记录

此处只记录日期、客户端版本、容器状态、自动测试数量和五项验收结论。不要记录偏好原文、事实原文或任何 key。首次真实验收完成后再填写。
