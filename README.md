# commitpick-cli

输入 `cmsg`，根据 Git 改动生成 3 条标准提交信息，方向键选择，回车复制。无需 Key 即可使用本地规则；配置 AI 后可生成更具体的语义描述。支持中英文和自定义 AI 中转地址。

```text
$ cmsg zh
范围：暂存区 · 中文 · 3 条候选
生成完成，用时 1.8 秒。
? 选择提交信息（回车复制，Ctrl+C 退出）
❯ fix(auth): 避免重复刷新令牌
  fix(auth): 复用进行中的刷新请求
  fix(auth): 串行处理令牌刷新
```

以上是交互示例，耗时仅为示意；实际速度和措辞取决于服务商、模型和 diff 大小。工具不自动暂存、提交或推送。

## 安装

需要 **Node.js >= 22.13** 和 **Git**。

当前为本地开发版本，尚未发布到 npm。在项目目录执行：

```sh
npm ci
npm run build
npm link
```

随后可在任意 Git 仓库中运行 `cmsg`。更新源码后重新 `npm run build` 即可生效。

发布到 npm 后，用户可执行：

```sh
npm install -g commitpick-cli
```

## 零配置使用

安装后直接在有改动的 Git 仓库运行 `cmsg`。没有 AI 配置时，自动使用本地规则，不要求 Key、不调用网络、不弹出配置向导。

```sh
cmsg zh --local         # 即使已配置 AI，也显式使用本地规则
cmsg --local --json     # 供脚本使用，source 为 local
```

本地规则只读取文件操作清单，根据新增、修改、删除、重命名、复制和类型变更给出同一组改动的不同表述。纯文档、测试、CI 变更使用 `docs`、`test`、`ci`，其余使用 `chore`；不分析代码含义、不推断 `fix` 或 `feat`。长路径或较复杂的操作组合会使用操作计数：`A` 新增、`M` 修改、`D` 删除、`R` 重命名、`C` 复制、`T` 类型变更。候选仍满足单行、不重复、最多 100 字符的约束。

本地模式默认英文、3 条候选，使用 `zh` / `--lang`、`--count` 调整。显式 `--local` 不读取 AI 配置，因此配置损坏或环境变量错误也不会阻碍本地使用。`--hint` 只适用于 AI 模式。已配置的 AI 请求失败时会报告错误，不静默降级；可再次使用 `--local`。

## 配置 AI（可选）

```sh
cmsg setup
```

依次填写 5 项：

1. **AI 接口协议**：Responses 或 Chat Completions。新配置默认选中 Responses；已有配置保留原协议。
2. **AI 地址**：可填域名、Base URL 或完整接口地址。
3. **API Key**：输入时隐藏；本地无认证服务可留空。
4. **模型名**：填写服务商提供的准确名称。
5. **默认语言**：English 或简体中文。

地址会按所选协议自动处理：

| 输入                           | Responses                                | Chat Completions                                |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| `https://relay.example`        | `https://relay.example/v1/responses`     | `https://relay.example/v1/chat/completions`     |
| `https://relay.example/v1`     | `https://relay.example/v1/responses`     | `https://relay.example/v1/chat/completions`     |
| `https://relay.example/api/v1` | `https://relay.example/api/v1/responses` | `https://relay.example/api/v1/chat/completions` |

完整接口地址在协议一致时保持原样；切换协议会替换末尾的 `/responses` 或 `/chat/completions`，保留前面的自定义路径，不会重复拼接。

支持 OpenAI 兼容 **Responses** 和 **Chat Completions** 协议，包括兼容的中转站和本地服务。不直接支持 Anthropic Messages 或 Gemini 原生协议。模型需要能遵循 JSON 输出指令；请求不强制使用服务商特有的结构化输出参数。Responses 请求使用 `store: false`、`stream: false`；只有完成状态的文本才会作为候选解析。

再次运行 `cmsg setup` 可修改配置。Key 留空会保留原值，输入 `-` 清空。配置保存不会发起模型请求；运行 `cmsg` 会把所选范围的 diff 发送给配置的地址。

```sh
cmsg config  # 查看生效配置，Key 始终隐藏
cmsg test    # 发送固定微小示例，测试连接及候选格式，不读取仓库
cmsg test --json  # 测试结果以 JSON 输出，诊断信息写 stderr
```

`cmsg test` 可在任意目录运行，只发起一次模型请求，验证所选协议、模型、认证和一条 Conventional Commit 候选的格式。它会显示实际请求地址、协议和模型；失败时返回非零退出码，不输出 Key 或服务商原始错误正文。固定示例成功不代表实际大改动一定成功。

如果中转站的 Codex 配置中写着 `wire_api = "responses"`，在 `cmsg setup` 中选择 **Responses**，填写相同 Base URL，以及该 Key 有权限使用的模型。`cmsg` 使用自己的配置，不会自动读取 Codex 配置或凭据。已有 Chat Completions 配置不会在升级时自动切换。

也可以在 PowerShell 当前会话临时切换后测试：

```powershell
$env:CMSG_PROTOCOL = 'responses'
cmsg config
cmsg test
```

这个覆盖会沿用已有 Key 和模型，并把已知的 `/chat/completions` 后缀改为 `/responses`。测试后用 `Remove-Item Env:CMSG_PROTOCOL` 移除临时覆盖；要持久切换，请运行 `cmsg setup`。

HTTP 403 表示服务端拒绝访问，不能单凭状态码确定是 Key、模型、协议还是中转站访问限制。请先核对 `cmsg config`，再运行 `cmsg test`；需要具体拒绝原因时查看中转站日志或联系服务商。程序不会自动尝试其他协议或重复请求。

### 代理与连接诊断

Windows 系统代理不会自动用于请求。如果浏览器可以连接而 `cmsg` 连接超时，请显式设置代理地址。以下仅影响当前 PowerShell 会话，端口应与代理软件中的 HTTP / mixed 端口一致：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
cmsg test
```

支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及其小写形式，小写优先；只设置 `HTTP_PROXY` 时也用于 HTTPS。`NO_PROXY` 指定需要直连的主机，`*` 表示全部直连。无需 `NODE_USE_ENV_PROXY`，兼容 Node.js 22.13。代理配置不会保存到 AI 配置中。

连接失败会显示已知的底层错误码，例如 `ENOTFOUND`（DNS）、`ECONNREFUSED`（连接拒绝）、`ETIMEDOUT`（连接超时）和证书错误，并给出对应检查方向。不会输出 Key、代理凭据或原始错误正文。

## 日常使用

```sh
cmsg                  # 默认语言，3 条候选，选中后自动复制
cmsg zh               # 本次中文
cmsg en               # 本次英文
cmsg -l zh            # 与 cmsg zh 相同
cmsg -n 1             # 只生成 1 条候选（支持 1–5 条）
cmsg -s               # 严格只读暂存区
cmsg -w               # 工作区全部待提交改动预览
cmsg -p               # 打印全部候选，不选择、不复制
cmsg --local          # 使用零配置本地规则
cmsg --hint "修复重复点击引起的重复提交"
cmsg --pick 2 -c      # 直接复制第 2 条候选
cmsg --help
```

候选是**同一次提交的不同表述**，不是自动拆成 3 次提交。AI 模式中的 `fix`、`feat`、`refactor` 等类型由模型根据实际改动确定，scope 可选。中文模式仍使用英文类型及 ASCII 冒号，如 `fix(auth): 避免重复刷新令牌`。

### 改动范围

| 模式                             | 输入范围                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------ |
| 默认 `auto`，有 staged changes   | 只读取索引中的 staged diff；同一文件的未暂存部分不会混入                       |
| 默认 `auto`，没有 staged changes | 工作区相对 HEAD 的净变化，加上未跟踪文件                                       |
| `--staged` / `-s`                | 只读取暂存区；为空则提示，不自动回退                                           |
| `--worktree` / `-w`              | 工作区相对 HEAD 的最终状态，加上未跟踪文件；包含已暂存及未暂存改动的最终净效果 |

未跟踪文件遵循 `.gitignore`。首次提交前的空仓库也可以使用。二进制文件只提供变更元数据，不上传二进制内容；非 UTF-8 新文件只提供元数据。冲突未解决时拒绝生成。

**改动大也可以直接运行 `cmsg`，无需拆分暂存区。** 小改动直接提供完整 diff；大改动自动整理为全部文件的操作和增删行数，以及源码全文或分布在文件不同位置的片段。常见构建产物（如 `dist/`、`build/`、`public/**/assets/`、压缩 JS、source map）和锁文件在整理模式下只提供文件变更统计，避免占据模型输入。是否保留完整 diff 以约 160 KB 及单行长度为内部整理阈值，不作为使用限制；未跟踪文件也不再有 200 个的数量限制。

整理模式会在 stderr 提示，并在模型输入中标明省略内容；全部文件操作仍然保留，模型仅根据可见内容生成候选。大改动仍只调用一次模型。片段无法覆盖每一行细节，涉及重要意图时可以用 `--hint` 补充。

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
    "fix(auth): serialize token refresh calls"
  ]
}
```

`source` 区分 `ai` 与 `local`。无 TTY 时默认打印候选，不等待交互输入。`--json`、`--print` 与复制/直接选择参数互斥。生成、连接或格式错误返回非零退出码，Ctrl+C 取消菜单返回 130。剪贴板失败时消息仍会输出，并返回错误。

Windows 文本复制使用系统 `clip.exe`，以不带 BOM 的 UTF-16LE 传入提交信息，避免 PowerShell 启动、控制台编码乱码和不可见的 BOM 字符。复制最多等待 2 秒，超时会终止复制进程并提示手工复制；其他平台继续使用 clipboardy。`cmsg --print` 可完全跳过选择和复制。

## 配置位置与环境变量

默认配置文件：

- Windows：`%APPDATA%/commitpick/config.json`。
- macOS / Linux：`~/.config/commitpick/config.json`。
- 设置了 `XDG_CONFIG_HOME` 时，优先使用其下的 `commitpick/config.json`。

Key 保存在用户配置文件中，不进入 Git 仓库；Unix 文件权限为 `0600`，Windows 继承用户目录权限。也可通过环境变量提供 Key。环境变量优先于保存的设置，`setup` 不会持久化临时环境变量。

| 环境变量        | 作用                                           |
| --------------- | ---------------------------------------------- |
| `CMSG_PROTOCOL` | 覆盖协议：`responses` 或 `chat-completions`    |
| `CMSG_BASE_URL` | 覆盖 AI 地址，接受与 setup 相同的格式          |
| `CMSG_API_KEY`  | 覆盖 API Key，允许空值                         |
| `CMSG_MODEL`    | 覆盖模型名                                     |
| `CMSG_CONFIG`   | 指定配置文件完整路径，可用于多套配置和隔离测试 |

同时提供 `CMSG_BASE_URL` 和 `CMSG_MODEL` 时，无需运行 setup。默认候选数为 3；持久调整可编辑配置文件的 `count`（1–5），单次调整用 `-n`。

保存的 `protocol` 或 `CMSG_PROTOCOL` 优先决定接口后缀。没有指定协议时，完整 `/responses` 地址会识别为 Responses，其余地址默认 Chat Completions，以兼容旧配置。`cmsg config` 始终显示最终生效的协议与地址。

每次生成只发一次请求，不自动重试，超时为 30 秒。格式不合规或候选重复会提示重试。若希望更快，选择适合短文本的低延迟模型，并保持单次提交范围清晰。

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

### 发布当前版本

当前版本已是 `0.4.0`，无需再执行 `npm version`。确认本次改动均已提交、工作区干净，并且官方源尚未发布 `0.4.0`，然后执行：

```sh
git push origin main
git tag -a v0.4.0 -m "Release v0.4.0"
git push origin v0.4.0
```

推送 `v*` tag 会触发 `Publish to npm`。流程先复用 CI 的 Windows / Ubuntu、Node.js 22 / 24 检查矩阵，全部通过后校验 tag、`package.json` 和锁文件版本一致，再在 GitHub 托管的 Ubuntu runner 上使用 Node.js 24、npm 11 发布。当前流程只接受 `v主版本.次版本.修订版本` 正式版本，不发布预发布版本。

`prepublishOnly` 会再次执行检查，`prepack` 会构建产物。发布内容只包含 `dist`、README、LICENSE 及 npm 必需的 package.json。普通分支推送和 PR 只运行 CI，不发布。

在 [GitHub Actions](https://github.com/liuhuakawaii/commitpick-cli/actions) 查看结果，成功后可查询官方源验证：

```sh
npm view commitpick-cli@0.4.0 version --registry=https://registry.npmjs.org/
```

### 后续版本

在 `main` 分支提交完功能改动、保持工作区干净后，按变更类型执行 `npm version patch`、`npm version minor` 或 `npm version major`。该命令会同步包和锁文件版本，并创建版本提交及 tag。例如从 `0.4.0` 发布修订版本：

```sh
npm version patch
git push origin main
git push origin v0.4.1
```

每次只推送本次发布的 tag。npm 不允许覆盖已发布的同名同版本；若认证或检查失败且版本尚未发布，修复原因后可在 Actions 中重新运行失败任务；若需要修改源码或 workflow，应提交修改并使用新的版本和 tag。

如需本地手动发布，首次登录或凭据失效时执行 `npm login --registry=https://registry.npmjs.org/`，再执行 `npm publish` 并完成认证。`publishConfig` 只在发布时生效，登录时仍需显式指定官方源；同一版本选择一种发布方式即可。

MIT License.
