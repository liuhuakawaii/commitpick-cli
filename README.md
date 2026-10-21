# commitpick-cli

输入 `cmsg`，根据 Git 改动生成 4 条标准提交信息（2 条 English、2 条简体中文），方向键选择，回车复制。菜单中也可以编辑候选、补充意图后重新生成，或查看本次文件范围。无需 Key 即可使用本地规则；配置 AI 后可生成更具体的语义描述。

```text
$ cmsg
范围：暂存区 · 2 个文件 · English + 中文 · 4 条候选
生成完成，总用时 1.8 秒。
? 选择提交信息（回车复制，Ctrl+C 退出）
❯ fix(auth): prevent duplicate token refresh requests
  fix(auth): reuse the pending refresh promise
  fix(auth): 避免重复发起令牌刷新
  fix(auth): 复用进行中的刷新请求
```

以上是交互示例，耗时仅为示意；实际速度和措辞取决于服务商、模型和 diff 大小。工具不自动暂存、提交或推送。

## 安装

需要 **Node.js >= 22.13** 和 **Git**。

已有版本发布到 npm，可直接安装。本文描述当前源码；本次双语与交互改进尚未发布，体验这些改进请使用下方的源码安装方式。

```sh
npm install -g commitpick-cli
```

随后可在任意 Git 仓库中运行 `cmsg`。从源码开发时再使用 `npm ci`、`npm run build` 和 `npm link`。

```sh
npm ci
npm run build
npm link
```

## 零配置使用

安装后直接在有改动的 Git 仓库运行 `cmsg`。没有 AI 配置时，自动使用本地规则，不要求 Key、不调用网络、不弹出配置向导。

```sh
cmsg zh --local         # 即使已配置 AI，也显式使用本地规则
cmsg --local            # 默认 2 条英文 + 2 条中文
cmsg --local --json     # 供脚本使用，source 为 local
```

本地规则只读取文件操作清单，根据新增、修改、删除、重命名、复制和类型变更给出同一组改动的不同表述。纯文档、测试、CI 变更使用 `docs`、`test`、`ci`，其余使用 `chore`；不分析代码含义、不推断 `fix` 或 `feat`。长路径或较复杂的操作组合会使用操作计数：`A` 新增、`M` 修改、`D` 删除、`R` 重命名、`C` 复制、`T` 类型变更。候选仍满足单行、不重复、最多 100 字符的约束。

少量文件保留路径，多文件尽量保留共同目录。例如修改 `src/auth.ts` 和 `src/token.ts` 时，本地候选包括 `chore: modify src/auth.ts, src/token.ts` 和 `chore: 修改 src/auth.ts, src/token.ts`；用户可以在菜单内补充实际意图。

默认生成 2 条英文和 2 条中文，共 4 条候选。使用 `zh` / `cn`、`en`、`--lang` 或 `--count` 调整。显式 `--local` 不读取 AI 配置，因此配置损坏或环境变量错误也不会阻碍本地使用。`--hint` 只适用于 AI 模式。已配置的 AI 请求失败时会报告错误，不静默降级；可再次使用 `--local`。

## 配置 AI（可选）

```sh
cmsg setup
```

首次配置先选择 **AI 来源**，默认选中 **OpenRouter 免费云端**。已有配置时，向导提供「编辑已有来源」「添加来源」「调整优先级」「移除来源」；新增来源放在列表末尾。每个来源有独立名称、协议、地址、Key、模型和超时，语言与候选数量仍为通用偏好。

例如先添加名为 `free` 的 OpenRouter 免费来源，再运行 `cmsg setup` 选择「添加来源」，配置名为 `paid` 的自定义 API；通过「调整优先级」依次选择 `free`、`paid`，即可先免费、失败后付费。`cmsg config` 显示实际生效的顺序，所有 Key 都会隐藏。

每次生成按优先级顺序尝试，每个来源最多一次；超时、网络或 HTTP 错误、未完成响应及候选格式校验失败时尝试下一项，成功即停止。回退复用同一份 diff、hint 和语言数量，不重新读取 Git。全部来源失败则报错，不自动降级为本地规则；菜单手动重新生成会从最高优先级重新尝试，全部失败时保留已有候选。**配置了付费来源，就可能在回退时产生费用**；只保留免费来源可避免调用付费 API。

### 免费云端（无需本地部署）

1. 注册 OpenRouter，在 [API Keys 页面](https://openrouter.ai/settings/keys) 创建 Key。
2. 运行 `cmsg setup`，选择 **OpenRouter 免费云端**，填写来源名称、Key、超时和默认语言。
3. 运行 `cmsg test` 验证连接、候选格式和耗时，再在项目中运行 `cmsg`。

此入口固定使用 `https://openrouter.ai/api/v1/chat/completions` 和 `openrouter/free`，不需要填写接口地址或模型名。按 [OpenRouter 官方说明](https://openrouter.ai/docs/guides/routing/routers/free-router)，路由本身和选中的免费模型均不收费，只在免费模型池中选择；具体模型会变化，不保证使用 DeepSeek 或 GPT。CLI 不向该路由传入付费候选模型，但会回退到你在列表中另外配置的来源，并在 stderr 显示每次尝试和失败原因。

免费服务有额度、限流和可用性限制，高峰时可能较慢；无需部署模型，但需要网络和 OpenRouter API Key。限额以 [服务商当前规则](https://openrouter.ai/docs/api/reference/limits) 和账号状态为准。配置不会测试网络；`cmsg test`、实际生成和手动重新生成都会消耗请求额度。

新增来源不继承其他来源的 Key；编辑时，只有地址仍属于同一 origin（协议、域名、端口相同）才可回车保留 Key。临时环境变量只覆盖最高优先级来源，并将它作为本次唯一来源；若设置过 `CMSG_BASE_URL`、`CMSG_MODEL`、`CMSG_PROTOCOL` 或 `CMSG_API_KEY`，请移除对应覆盖以恢复完整列表，并用 `cmsg config` 确认。

### 自定义 API

选择 **自定义 API** 后，填写来源名称及以下设置：

1. **AI 接口协议**：Responses 或 Chat Completions。新配置默认选中 Responses；已有配置保留原协议。
2. **AI 地址**：可填域名、Base URL 或完整接口地址。
3. **API Key**：输入时隐藏；本地无认证服务可留空。
4. **模型名**：填写服务商提供的准确名称。
5. **请求超时**：每个来源独立设置，默认 30 秒，最多 120 秒；免费来源较慢时可设置更短超时以更快回退。
6. **默认语言**：English、简体中文或双语（默认 2+2），对所有来源生效。

地址会按所选协议自动处理：

| 输入                           | Responses                                | Chat Completions                                |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| `https://relay.example`        | `https://relay.example/v1/responses`     | `https://relay.example/v1/chat/completions`     |
| `https://relay.example/v1`     | `https://relay.example/v1/responses`     | `https://relay.example/v1/chat/completions`     |
| `https://relay.example/api/v1` | `https://relay.example/api/v1/responses` | `https://relay.example/api/v1/chat/completions` |

完整接口地址在协议一致时保持原样；切换协议会替换末尾的 `/responses` 或 `/chat/completions`，保留前面的自定义路径，不会重复拼接。

支持 OpenAI 兼容 **Responses** 和 **Chat Completions** 协议，包括兼容的中转站和本地服务。不直接支持 Anthropic Messages 或 Gemini 原生协议。模型需要能遵循 JSON 输出指令；请求不强制使用服务商特有的结构化输出参数。Responses 请求使用 `store: false`、`stream: false`；只有完成状态的文本才会作为候选解析。

再次运行 `cmsg setup` 可管理配置。自定义 API 在同一 origin 下 Key 留空保留原值，输入 `-` 清空。配置保存不会发起模型请求；运行 `cmsg` 会把所选范围的 diff 发送给依次尝试的来源。

```sh
cmsg config  # 查看生效配置，Key 始终隐藏
cmsg test    # 发送固定微小示例，测试连接及候选格式，不读取仓库
cmsg test --json  # 测试结果以 JSON 输出，诊断信息写 stderr
```

`cmsg test` 可在任意目录运行，用固定示例按相同优先级测试，成功即停止，不逐个探测全部来源。它验证协议、模型、认证和一条 Conventional Commit 候选的格式，显示每次尝试的地址、协议和模型；全部失败时返回非零退出码，不输出 Key 或服务商原始错误正文。固定示例成功不代表实际大改动一定成功。

如果中转站的 Codex 配置中写着 `wire_api = "responses"`，在 `cmsg setup` 中选择 **Responses**，填写相同 Base URL，以及该 Key 有权限使用的模型。`cmsg` 使用自己的配置，不会自动读取 Codex 配置或凭据。已有 Chat Completions 配置不会在升级时自动切换。

也可以在 PowerShell 当前会话临时切换后测试：

```powershell
$env:CMSG_PROTOCOL = 'responses'
cmsg config
cmsg test
```

这个覆盖会沿用最高优先级来源的 Key 和模型，并把已知的 `/chat/completions` 后缀改为 `/responses`；本次只使用该来源，不回退到保存的其他来源。测试后用 `Remove-Item Env:CMSG_PROTOCOL` 移除临时覆盖；要持久切换，请运行 `cmsg setup`。

HTTP 403 表示服务端拒绝访问，不能单凭状态码确定是 Key、模型、协议还是中转站访问限制。请先核对 `cmsg config`，再运行 `cmsg test`；需要具体拒绝原因时查看中转站日志或联系服务商。程序不会重试同一来源或为它探测其他协议，但会尝试列表中的下一来源。

### 代理与连接诊断

Windows 下，代理软件开启“系统代理”后，`cmsg` 会自动读取当前用户的静态代理（Internet Settings），不需要重复填写代理地址。显式设置 `HTTP_PROXY` / `HTTPS_PROXY` 时优先使用环境变量；单独设置 `NO_PROXY` 会补充系统代理的绕过规则，`NO_PROXY=*` 强制直连。本机地址默认不经过自动发现的系统代理。

请求前会在 stderr 显示代理来源或直连原因。以下变量只影响当前 PowerShell 会话，适合临时覆盖系统代理，端口应与代理软件中的 HTTP / mixed 端口一致：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
cmsg test
```

支持上述变量的小写形式，小写优先；只设置 `HTTP_PROXY` 时也用于 HTTPS。Windows 静态代理支持统一地址、按 HTTP/HTTPS 分开的地址，以及通配符、端口和 `<local>` 绕过规则。仅配置 PAC 脚本时会提示并直连；需要代理时可显式指定 HTTP / mixed 地址。macOS / Linux 使用环境变量或系统级网络隧道，不自动读取桌面代理设置。无需 `NODE_USE_ENV_PROXY`，兼容 Node.js 22.13。代理配置不会保存到 AI 配置中。

每个来源可以单独设置连接方式；省略 `proxyMode` 等同 `auto`。`auto` 在本来源的总超时预算内，连接或超时失败时依次尝试环境代理、Windows 静态系统代理和直连；HTTP、JSON 或候选格式错误不会在同一来源内重复请求。`proxy` 只使用可用代理，`direct` 只直连。程序不会并发发起这些请求。

需要临时覆盖自动选择时，可设置 `CMSG_PROXY_MODE`：`auto` 使用上述有界回退链，`proxy` 只使用代理，`direct` 强制直连；`system` 忽略显式代理变量并只使用 Windows 静态系统代理。它只影响当前进程，不会保存配置。provider 的 `proxyMode` 优先于这个环境变量。

```powershell
$env:CMSG_PROXY_MODE = 'direct'
cmsg test
Remove-Item Env:CMSG_PROXY_MODE
```

连接失败会显示已知的底层错误码，例如 `ENOTFOUND`（DNS）、`ECONNREFUSED`（连接拒绝）、`ETIMEDOUT`（连接超时）和证书错误，并给出对应检查方向。不会输出 Key、代理凭据或原始错误正文。

## 日常使用

```sh
cmsg                  # 默认语言，4 条候选，选中后自动复制
cmsg zh               # 本次中文
cmsg en               # 本次英文
cmsg -l zh            # 与 cmsg zh 相同
cmsg -n 1             # 只生成 1 条候选（支持 1–5 条）
cmsg --preview       # 查看本次文件范围和待发送内容，不请求 AI
cmsg --files         # 在 stderr 列出本次纳入的文件
cmsg -s               # 严格只读暂存区
cmsg -w               # 工作区全部待提交改动预览
cmsg -p               # 打印全部候选，不选择、不复制
cmsg --local          # 使用零配置本地规则
cmsg --hint "修复重复点击引起的重复提交"
cmsg --pick 2 -c      # 直接复制第 2 条候选
cmsg --help
```

候选是**同一次提交的不同表述**，不是自动拆成多次提交。双语默认顺序为 English、English、中文、中文；`-n` 表示总数，奇数时英文多一条（例如 `-n 3` 为 2 EN + 1 中文，`-n 1` 为英文）。`en` / `zh` / `cn` 则全部使用指定语言。提示词要求 AI 复用同一组事实和 type/scope，使用准确的「动作 + 对象」，省去冗余说明和空泛收益；英文整行以 50 字符以内、中文描述以 8–18 字为目标，事实准确优先。100 字符硬限制仍保留，不截断模型输出。中文候选仍使用英文类型及 ASCII 冒号；语义与措辞质量仍需核对。

交互菜单支持“编辑第 N 条”“补充意图后重新生成”“重新生成”和“查看本次文件范围”。重新生成由用户主动触发，会再次请求 AI，复用本次已收集的改动快照；失败时保留原候选。若仓库发生新改动，请重新运行 `cmsg` 收集。

### 改动范围

| 模式                             | 输入范围                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------ |
| 默认 `auto`，有 staged changes   | 只读取索引中的 staged diff；同一文件的未暂存部分不会混入                       |
| 默认 `auto`，没有 staged changes | 工作区相对 HEAD 的净变化，加上未跟踪文件                                       |
| `--staged` / `-s`                | 只读取暂存区；为空则提示，不自动回退                                           |
| `--worktree` / `-w`              | 工作区相对 HEAD 的最终状态，加上未跟踪文件；包含已暂存及未暂存改动的最终净效果 |

未跟踪文件遵循 `.gitignore`。首次提交前的空仓库也可以使用。二进制文件只提供变更元数据，不上传二进制内容；非 UTF-8 新文件只提供元数据。冲突未解决时拒绝生成。

小改动提供完整 diff，超过 24,000 bytes 或含构建产物时自动整理，源码细节预算为 20,000 bytes，保留分布在文件不同位置的片段。全部文件操作与增删行统计仍保留；这部分元数据另计，因此总输入并非严格限制为 24 KB。常见构建产物（如 `dist/`、`build/`、`public/**/assets/`、压缩 JS、source map）和锁文件始终仅提供元数据。大改动可以运行，但多个独立目的是否应合并为一次提交仍由用户判断。

整理模式会在 stderr 提示，并在模型输入中标明省略内容；全部文件操作仍然保留，模型仅根据可见内容生成候选。大改动不会额外拆分模型请求，回退时复用同一份整理结果。片段无法覆盖每一行细节，涉及重要意图时可以用 `--hint` 补充。

### 脚本使用

```sh
cmsg -s --json         # stdout 只输出 JSON，进度写入 stderr
cmsg --pick 1         # 非交互环境：stdout 只输出第 1 条消息
cmsg --pick 1 -c       # 非交互环境：输出并复制第 1 条
```

```json
{
  "scope": "staged",
  "source": "ai",
  "messages": [
    "fix(auth): prevent duplicate token refresh requests",
    "fix(auth): reuse the pending refresh promise",
    "fix(auth): 避免重复发起令牌刷新",
    "fix(auth): 复用进行中的刷新请求"
  ],
  "languages": ["en", "en", "zh", "zh"]
}
```

`source` 区分 `ai` 与 `local`。AI 结果还包含 `provider`（成功来源的 `name`、`protocol`、`endpoint`、`model`，不含 Key）。`languages` 与候选一一对应，成功来源返回用量时还包含 `usage`（`inputTokens`、`outputTokens`、`totalTokens`，未提供的字段省略）；它不是整个回退链的费用统计，失败请求也可能消耗额度。`--preview --json` 输出范围、文件清单、`diff`、`inputBytes` 和 `summarized`，不含候选、不调用 AI。`inputBytes` 仅统计 diff，不含提示词、hint 和协议包装。

无 TTY 时默认打印候选，不等待交互输入。`--json`、`--print` 与复制/直接选择参数互斥。生成、连接或格式错误返回非零退出码，Ctrl+C 取消菜单返回 130。剪贴板失败时消息仍会输出，并返回错误。

Windows 文本复制使用系统 `clip.exe`，以不带 BOM 的 UTF-16LE 传入提交信息，避免 PowerShell 启动、控制台编码乱码和不可见的 BOM 字符。复制最多等待 2 秒，超时会终止复制进程并提示手工复制；其他平台继续使用 clipboardy。`cmsg --print` 可完全跳过选择和复制。

## 配置位置与环境变量

默认配置文件：

- Windows：`%APPDATA%/commitpick/config.json`。
- macOS / Linux：`~/.config/commitpick/config.json`。
- 设置了 `XDG_CONFIG_HOME` 时，优先使用其下的 `commitpick/config.json`。

Key 保存在用户配置文件中，不进入 Git 仓库；Unix 文件权限为 `0600`，Windows 继承用户目录权限。也可通过环境变量提供 Key。环境变量优先于保存的设置，`setup` 不会持久化临时环境变量。

| 环境变量          | 作用                                            |
| ----------------- | ----------------------------------------------- |
| `CMSG_PROTOCOL`   | 覆盖协议：`responses` 或 `chat-completions`     |
| `CMSG_BASE_URL`   | 覆盖 AI 地址，接受与 setup 相同的格式           |
| `CMSG_API_KEY`    | 覆盖 API Key，允许空值                          |
| `CMSG_MODEL`      | 覆盖模型名                                      |
| `CMSG_PROXY_MODE` | 代理模式：`auto`、`proxy`、`direct` 或 `system` |
| `CMSG_CONFIG`     | 指定配置文件完整路径，可用于多套配置和隔离测试  |

同时提供 `CMSG_BASE_URL` 和 `CMSG_MODEL` 时，无需运行 setup。设置任一 AI 环境覆盖后，本次仅使用覆盖后的最高优先级来源，不回退；`CMSG_CONFIG` 本身只是文件路径，不关闭回退。通用偏好单独保存到 `<配置文件路径>.preferences.json`，AI 配置损坏不影响 `--local`。旧单来源配置以 `default` 名称兼容读取，不在读取时改写文件；下次保存升级为 `providers` 数组。旧文件的 `language` / `count` 不再决定默认输出。

配置文件的 `providers` 数组顺序就是优先级，例如：

```json
{
  "providers": [
    {
      "name": "free",
      "protocol": "chat-completions",
      "endpoint": "https://openrouter.ai/api/v1/chat/completions",
      "apiKey": "YOUR_OPENROUTER_KEY",
      "model": "openrouter/free",
      "timeoutMs": 10000,
      "proxyMode": "auto"
    },
    {
      "name": "paid",
      "protocol": "responses",
      "endpoint": "https://relay.example/v1/responses",
      "apiKey": "YOUR_PAID_KEY",
      "model": "YOUR_MODEL",
      "timeoutMs": 30000,
      "proxyMode": "direct"
    }
  ]
}
```

名称必须唯一，使用 1–40 个英文字母、数字、点、下划线或连字符。`timeoutMs` 是 1–120000 的整数，省略时为 30000；`proxyMode` 可选值为 `auto`、`proxy`、`direct`，省略时为 `auto`。`auto` 的多个网络路径共享同一个 `timeoutMs` 总预算。空列表恢复无 AI 配置的本地模式。移除来源前自动备份原列表。

```sh
cmsg config --lang both --count 4  # 保存偏好，无需配置 AI
cmsg config --lang zh --count 2    # 保存单语言偏好
cmsg config --reset-preferences    # 备份偏好后恢复双语 4 条
cmsg setup --reset                # 完成向导后备份旧 AI 配置并替换
```

备份保存在原文件旁，使用唯一的 `.bak` 文件名。取消配置向导不会替换原 AI 配置。

保存的 `protocol` 或 `CMSG_PROTOCOL` 优先决定接口后缀。没有指定协议时，完整 `/responses` 地址会识别为 Responses，其余地址默认 Chat Completions，以兼容旧配置。`cmsg config` 始终显示最终生效的协议与地址。

只有首选来源成功时，每次生成才只发一次请求；发生失败时最多尝试全部已配置来源各一次，等待时间可能累计到各来源超时之和。每个来源在同一请求中生成全部中英文候选。成功来源若返回 usage，CLI 会在 stderr 显示输入、输出和总 token；没有 usage 时明确显示未返回，不把字节估算当成计费用量。输入压缩减少上下文，但实际耗时还取决于服务商、模型和输出速度；本地模式不消耗模型 token。

## 开发与验证

```sh
npm ci
npm run dev -- zh --print
npm run format
npm run check
npm pack --dry-run
```

`check` 包括格式检查、TypeScript 类型检查、自动化测试和构建。测试通过真实临时 Git 仓库、本地模拟 Responses / Chat Completions 服务和 HTTP CONNECT 代理覆盖范围语义、中英文候选、本地规则、协议切换、代理与直连、超时及脱敏错误。Windows 复制测试使用真实子进程验证 Unicode 输入、超时终止和失败路径，不改动系统剪贴板。真实剪贴板、交互式菜单、模型语义准确性和服务商延迟需要额外验证。

GitHub Actions 已配置 Windows / Ubuntu、Node.js 22 / 24 检查矩阵；推送到 GitHub 后运行。

语义质量样本与人工判据见 [docs/quality.md](docs/quality.md)。自动化测试验证范围、输出契约和采样边界，不把模拟响应当作真实模型质量结论。

## 发布到 npm

包名为 `commitpick-cli`，命令名为 `cmsg`。`package.json` 中的 `publishConfig.registry` 指定发布到 npm 官方源，不影响日常安装依赖使用的源。

### 一次性配置可信发布

发布使用 npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)（OIDC），保留账号 2FA，不需要在 GitHub Secrets 中保存 `NPM_TOKEN`，也不需要在 Actions 中执行 `npm login`。

先将发布配置提交并推送到 `liuhuakawaii/commitpick-cli` 的 `main` 分支，再打开 [npm 包设置](https://www.npmjs.com/package/commitpick-cli/access)，在 Trusted Publisher 区域选择 GitHub Actions，填写：

| 字段                 | 值                                                         |
| -------------------- | ---------------------------------------------------------- |
| Organization or user | `liuhuakawaii`                                             |
| Repository           | `commitpick-cli`                                           |
| Workflow filename    | `publish.yml`（只填文件名）                                |
| Environment name     | 留空（workflow 未设置 environment）                        |
| Allowed actions      | 允许直接发布 `npm publish`，不能只允许 `npm stage publish` |

保存时按 npm 提示完成 2FA。新建的可信发布配置需要在 2 天内完成首次成功发布，否则过期后需删除并重新配置，具体以 npm 页面及官方说明为准。只允许暂存发布时，仍需人工用 2FA 审批才能上线。

### 发布新版本

`0.4.1` 已发布，不能覆盖。提交本次源码改动并保持工作区干净后，按变更类型升级版本，再推送对应 tag。例如发布一个 minor 版本：

```sh
npm version minor
git push origin main
git push origin v0.5.0
```

推送 `v*` tag 会触发 `Publish to npm`。流程先复用 CI 的 Windows / Ubuntu、Node.js 22 / 24 检查矩阵，全部通过后校验 tag、`package.json` 和锁文件版本一致，再在 GitHub 托管的 Ubuntu runner 上使用 Node.js 24、npm 11 发布。当前流程只接受 `v主版本.次版本.修订版本` 正式版本，不发布预发布版本。

`prepublishOnly` 会再次执行检查，`prepack` 会构建产物。发布内容只包含 `dist`、README、LICENSE 及 npm 必需的 package.json。普通分支推送和 PR 只运行 CI，不发布。

在 [GitHub Actions](https://github.com/liuhuakawaii/commitpick-cli/actions) 查看结果，成功后可查询官方源验证：

```sh
npm view commitpick-cli@0.5.0 version --registry=https://registry.npmjs.org/
```

### 后续版本

在 `main` 分支提交完功能改动、保持工作区干净后，按变更类型执行 `npm version patch`、`npm version minor` 或 `npm version major`。该命令会同步包和锁文件版本，并创建版本提交及 tag。例如从 `0.4.1` 发布修订版本：

```sh
npm version patch
git push origin main
git push origin v0.4.2
```

每次只推送本次发布的 tag。npm 不允许覆盖已发布的同名同版本；若认证或检查失败且版本尚未发布，修复原因后可在 Actions 中重新运行失败任务；若需要修改源码或 workflow，应提交修改并使用新的版本和 tag。

如需本地手动发布，首次登录或凭据失效时执行 `npm login --registry=https://registry.npmjs.org/`，再执行 `npm publish` 并完成认证。`publishConfig` 只在发布时生效，登录时仍需显式指定官方源；同一版本选择一种发布方式即可。

MIT License.
