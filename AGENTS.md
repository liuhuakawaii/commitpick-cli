# commitpick-cli

这是独立的 TypeScript / Node.js CLI 项目，npm 包名 `commitpick-cli`，可执行命令 `cmsg`。中文文本使用 UTF-8。

## 模块边界

- `src/git.ts` 拥有改动范围、Git 流式读取和模型输入整理。
- `src/config.ts` 拥有配置路径、有序来源列表、校验、旧单来源兼容、环境变量覆盖和原子保存。
- `src/setup.ts` 拥有交互式配置流程；不把环境变量中的临时值写入持久配置。
- 配置向导管理来源的添加、编辑、优先级和移除；移除前备份。新增来源不继承 Key；编辑时只在同一 origin 下保留旧 Key。
- `src/ai.ts` 拥有 Responses / Chat Completions 请求、按来源优先级回退、独立超时和候选格式校验。
- `src/proxy.ts` 拥有环境变量及 Windows 静态系统代理解析、绕过列表和请求 dispatcher 创建。
- `src/local.ts` 拥有本地文件操作到候选措辞的确定性规则，不推断代码语义。
- `src/selection.ts` 拥有候选编辑、显式重新生成及失败后保留结果的交互状态；不复制、不修改 Git。
- `src/clipboard.ts` 拥有平台剪贴板写入；Windows 使用 clip.exe、UTF-16LE 输入和可终止的 2 秒超时。
- `src/cli.ts` 只组合参数、生成模式、流程、选择菜单、输出与复制调用。

## 行为契约

- 不执行 `git add`、`git commit`、`git push`，不改动用户的索引和文件。
- `auto` 有暂存改动就只读取索引；否则读取工作区相对 HEAD 的净变化及未跟踪文件。
- `worktree` 包含工作区相对 HEAD 的最终状态；不能简单拼接 staged diff 和 unstaged diff。
- 支持首次提交前的仓库、部分暂存、删除、重命名和 UTF-8 文件名。
- 一次请求默认返回同一组改动的 4 种候选措辞，顺序为 2 条英文、2 条中文；中英文由配置或本次参数确定。
- AI 返回非空且全部候选格式有效时，数量与请求不符仅在 stderr 提示，保留全部候选，不因此回退或失败；数量不符时不按原请求的位置校验语言顺序，JSON languages 按实际描述识别。空数组、重复及无效候选仍失败。`cmsg test` 同样展示全部有效候选；`--pick` 超出实际返回数量时先展示已有候选再报错，不复制不存在的结果。
- 没有 AI 配置时使用本地规则，不要求 Key 或弹出配置；`--local` 跳过 AI 配置及网络。默认 2 条英文 + 2 条中文，共 4 条，可用语言及数量参数覆盖；`--hint` 仅适用于 AI。
- 本地模式只读取 Git 文件操作元数据，保留相同范围语义。已配置 AI 的请求失败时不静默降级。生成 JSON 的 `source` 为 `ai` 或 `local`。
- 输出必须是单行 Conventional Commit，不接受重复、控制字符或超长候选。提示词要求简短专业的动作与对象，英文整行以 50 字符以内、中文描述以 8–18 字为软目标；准确优先，硬限制仍为 100 字符，不机械截断。
- 不因 diff 大小或未跟踪文件数量拒绝生成。除始终省略正文的路径外，小改动提供完整 diff；大改动自动保留全部文件操作和行数统计，源码提供全文或分布采样片段，常见构建产物和锁文件只提供元数据。摘要中的省略必须明确标注，并在 stderr 提示；不因输入大小拆分请求。
- 二进制和非 UTF-8 新文件只提供元数据。大文件流式读取，避免完整缓冲构建产物。
- `--json` 的 stdout 只能是 JSON；进度和范围写 stderr。API Key 不出现在输出中。
- 配置存于用户配置目录，不存进项目。`CMSG_CONFIG` 可隔离测试配置。语言与数量独立保存在 `<配置路径>.preferences.json`，旧 AI 文件中的 language/count 不决定生成默认值；`--local` 不读取 AI 配置。显式 reset 先备份再替换。
- `providers` 数组顺序决定优先级，名称唯一，来源独立保存协议、地址、Key、模型、timeoutMs 及可选 proxyMode（auto/proxy/direct，默认 auto）。旧单来源以 default 名称只读兼容，下次保存升级。设置 AI 环境变量覆盖时仅使用覆盖后的首个来源，不回退到保存列表；CMSG_CONFIG 仅选择配置路径。
- `--preview` 不读取 AI 配置、不调用模型，显示本次文件范围及待发送 diff；`--files` 在 stderr 列出文件。生成 JSON 附带对应的 languages 和 AI 成功来源 provider（不含 Key），usage 仅采用成功来源实际返回的数值，不表示整条回退链费用。
- 完整 diff 阈值 24,000 bytes，源码细节预算 20,000 bytes；文件清单和统计另计，不能声称总输入有严格上限。构建产物和锁文件无论大小始终省略正文。任意目录下的 `AGENTS.md`、`README.md`，以及 `test/`、`tests/`、`__tests__/` 目录和 `*.test.*`、`*.spec.*` 文件同样始终省略正文（大小写不敏感），保留全部文件操作及增删行数；纯文档和纯测试提交仍可生成候选。
- 一次生成顺序尝试来源，每个来源最多请求一次；超时、网络或 HTTP 错误、未完成响应和候选格式错误触发下一来源，成功即停止，全部失败报错，不回退本地规则。stderr 显示尝试与失败，不输出原始服务商错误或 Key。菜单重新生成只在用户显式选择后发起，复用快照并从首个来源重试，全部失败保留已有候选。
- AI 请求按来源的 proxyMode 选择网络路径：auto 在单来源 timeoutMs 总预算内依次尝试 HTTP_PROXY / HTTPS_PROXY（小写优先）、Windows 当前用户 Internet Settings 中的静态系统代理和直连；proxy 只使用代理，direct 只直连。保留本机地址及系统绕过规则，NO_PROXY 补充绕过规则，`*` 强制直连；PAC 只显示诊断并直连，不执行脚本。只对网络连接失败和超时尝试下一路径，不重复请求 HTTP、JSON 或候选格式错误。显示代理来源、白名单网络错误码和检查方向，不输出原始错误文本或代理凭据；请求结束销毁代理连接。
- `protocol` 支持 `responses` 和 `chat-completions`；旧配置未指定协议时，从完整接口后缀推断，否则保持 Chat Completions。显式协议会替换已知接口后缀，保留路径前缀；不自动探测或重试其他协议。
- Responses 使用非流式请求及 `store: false`，只接受完成状态中的 assistant 文本。`cmsg test` 使用固定示例按同一优先级回退，成功即停止，不读取 Git 或仓库文件；评估脚本也复用回退流程并记录实际尝试次数。

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
