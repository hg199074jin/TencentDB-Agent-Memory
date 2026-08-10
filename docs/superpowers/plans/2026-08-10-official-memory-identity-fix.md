# 三端正式记忆身份统一修复

## Global Constraints

- 不迁移、不删除旧记忆，不修改 MemoryCore、MemoryPanel、MemoryProxy 的上游业务代码。
- 新建并复用元数据系统生成的正式 `usr-*`、`team-*`、`agt-*`、`task-*` 身份。
- 默认名称逐字使用：团队 `个人跨 Agent 记忆`、Agent `共享个人助手`、任务 `日常共享对话`；Agent 为团队可见并关联到任务。
- 所有文件覆盖前保留原始字节备份并原子替换；错误信息、日志和测试输出不得显示任何密钥。
- Claude Code 恢复 MiniMax 直连，三个模型请求均不经过 MemoryProxy；现有 Hook、插件、权限和模型映射保持不变。
- 使用测试驱动开发；完整回归、语法检查、差异检查和真实诊断均通过后才能切换本机配置。

### Task 1: 元数据正式身份引导与诊断

改造 `bootstrap-config.mjs`，默认读取部署 `.admin-key`，通过 Memory Hub 元数据 API 验证当前用户，并按精确名称查找或创建团队、Agent 和任务。不存在时依次创建；仅有一个有效精确匹配时复用；多个匹配、权限错误、返回结构错误或身份关系不一致时停止。任务须关联共享 Agent。把正式生成的 ID 写入 `config.local.json`，覆盖前保留原始字节备份，配置验证失败时不写半成品。引导过程应可注入元数据客户端以做真实行为测试，不把管理员 key 作为 Gateway Bearer。

扩展 `doctor.mjs`：在现有 config/Node/Gateway/L0/L1/L3/Hook 检查之外，验证配置中的 user/team/agent/task 都存在、归属一致且状态有效；已产生 chat_memory 资产时验证 Hub 可见，尚未首写时给出明确的非失败等待状态。所有输出保持脱敏。

先补失败测试并观察 RED，再做最小实现。覆盖：全新创建、幂等复用、同名冲突、部分创建后重试、权限/返回异常不覆盖配置、关系不一致、管理员 key 缺失、原始字节备份和 rename 失败恢复、doctor 正常与失败分支。

### Task 2: Claude Code MiniMax 直连恢复工具

新增独立命令，显式接收可信备份路径，默认目标为用户级 `.claude/settings.json`。验证源和目标都是对象型 JSON，源中 `ANTHROPIC_BASE_URL` 必须是 `https://api.minimaxi.com/anthropic`，且存在非空 `ANTHROPIC_AUTH_TOKEN`。只从源恢复这两个字段，并从目标删除 `ANTHROPIC_CUSTOM_HEADERS`；目标的 Hook、插件、权限、模型及其他字段全部保留。覆盖前把目标原始字节备份到 D 盘 adapter runtime，原子替换，失败时保持目标不变。CLI 不显示 token，支持可测试的 HOME/USERPROFILE 与路径注入保护。

先补失败测试并观察 RED，再做最小实现。覆盖：精确合并、非 UTF-8/损坏 JSON、错误域名、缺失 token、目标缺失、备份原始字节、rename 失败、幂等执行、CLI 脱敏与退出码。

### Task 3: 文档、安装回归与本机切换

更新 README，明确正式身份、Hub 查看路径、Claude 直连、旧数据保留、Proxy 停止与回滚、升级后 doctor 流程。增强安装回归测试，保证重新安装 Hook 不会改写 Claude 的供应商字段或正式身份配置。

在代码全套验证和整分支复核通过后，由主控制器在正式 `D:\TencentDB-Agent-Memory` 环境执行：创建/复用新身份、替换本机 adapter 配置、用可信备份恢复 Claude 直连、重新运行 Hook 安装幂等检查与 doctor。确认 Codex/Claude/ZCode 活跃配置不再指向 8096 后只停止 `tdai-proxy`，不删除容器、镜像或卷。真实客户端会话验收需要用户新开三个客户端会话完成；自动部分须先验证新身份首次写入后 Hub chat_memory 资产可读取。

先补需要的自动回归，再更新文档；运行完整 `npm test`、相关 `node --check`、`git diff --check` 和工作区清洁检查。
