# commitpick-cli

这是独立的 TypeScript / Node.js CLI 项目，npm 包名 `commitpick-cli`，可执行命令 `cmsg`。中文文本使用 UTF-8。

## 模块边界

- `src/git.ts` 拥有改动范围、Git 流式读取和模型输入整理。
- `src/config.ts` 拥有配置路径、校验、环境变量覆盖和原子保存。
- `src/setup.ts` 拥有交互式配置流程；不把环境变量中的临时值写入持久配置。
- `src/ai.ts` 拥有 Chat Completions 请求、超时和候选格式校验。
- `src/cli.ts` 只组合参数、流程、选择菜单、输出与剪贴板。

## 行为契约

- 不执行 `git add`、`git commit`、`git push`，不改动用户的索引和文件。
- `auto` 有暂存改动就只读取索引；否则读取工作区相对 HEAD 的净变化及未跟踪文件。
- `worktree` 包含工作区相对 HEAD 的最终状态；不能简单拼接 staged diff 和 unstaged diff。
- 支持首次提交前的仓库、部分暂存、删除、重命名和 UTF-8 文件名。
- 一次请求默认返回同一组改动的 3 种候选措辞，中英文由配置或本次参数确定。
- 输出必须是单行 Conventional Commit，不接受重复、控制字符或超长候选。
- 不因 diff 大小或未跟踪文件数量拒绝生成。小改动提供完整 diff；大改动自动保留全部文件操作和行数统计，源码提供全文或分布采样片段，常见构建产物和锁文件只提供元数据。摘要中的省略必须明确标注，并在 stderr 提示；只发起一次模型请求。
- 二进制和非 UTF-8 新文件只提供元数据。大文件流式读取，避免完整缓冲构建产物。
- `--json` 的 stdout 只能是 JSON；进度和范围写 stderr。API Key 不出现在输出中。
- 配置存于用户配置目录，不存进项目。`CMSG_CONFIG` 可隔离测试配置。

## 开发与验证

需要 Node.js >= 22.13、npm 和 Git。

```sh
npm ci
npm run dev -- --help
npm run format
npm run check
npm pack --dry-run
```

测试使用真实临时 Git 仓库及本地 HTTP 服务，不依赖外部模型或真实 Key。交互式菜单和系统剪贴板需额外手工验证。发布流程见 README；没有明确发布请求时不要执行 npm publish。
