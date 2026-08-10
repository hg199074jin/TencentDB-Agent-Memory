# Task 2 报告：Claude Code MiniMax 直连恢复工具

## 实现范围

- 新增 `integrations/cross-agent-memory/src/restore-claude-minimax.mjs` 及 npm 脚本 `restore-claude-minimax`。
- 命令仅接收一个显式的可信备份路径；默认目标由 `USERPROFILE`、`HOME` 或系统用户目录推导为 `.claude/settings.json`。
- 仅从来源恢复 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`，且只接受 `https://api.minimaxi.com/anthropic` 与非空 token；同时删除目标的 `ANTHROPIC_CUSTOM_HEADERS`。
- 目标的其余字段（含 hooks、插件、权限、模型和其他 env）保留。目标原始字节先备份至 adapter `runtime/backups`，再经临时文件 rename 原子替换。

## RED / GREEN

- RED：新增测试后执行 `node --test test/restore-claude-minimax.test.mjs`，因 `src/restore-claude-minimax.mjs` 尚不存在而以 `ERR_MODULE_NOT_FOUND` 失败；失败原因与新增命令缺失一致。
- GREEN：完成最小实现后，聚焦测试 6/6 通过。

## 验证

- 聚焦：`node --test test/restore-claude-minimax.test.mjs`，6 passed，0 failed。
- 全量：`npm test`，109 passed，0 failed。
- 静态：`node --check src/restore-claude-minimax.mjs` 与 `git diff --check` 均通过。

## 自审

- 源与目标均使用 fatal UTF-8 解码后校验为 JSON 对象；损坏、非 UTF-8、数组及缺失目标不会写入或备份。
- 未读取、修改真实用户 settings、备份、Docker 或服务；测试所有 HOME、USERPROFILE、源、目标和 runtime 均在临时目录。
- CLI 只接受一个非选项位置参数，拒绝选项和额外参数；成功输出明确的来源、目标和备份绝对路径，失败信息及输出均不含配置内容或 token。
- rename 失败测试确认目标原始字节未变且临时文件被清理；备份测试按 Buffer 比较，确认不是重编码后的文本。
- 未增加第三方运行时依赖。

## Concerns

- 无阻塞项。命令有意要求调用方提供已受信任的备份路径；它不尝试发现、选择或验证备份来源的可信链路。
