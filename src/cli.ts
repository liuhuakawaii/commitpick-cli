#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, Option, InvalidArgumentError } from 'commander';
import {
  backupConfig,
  candidateLanguages,
  configPath,
  loadConfig,
  loadPreferences,
  savePreferences,
  type Language,
} from './config.js';
import { collectChanges } from './git.js';
import { setupConfig } from './setup.js';
import { copyToClipboard } from './clipboard.js';
import { generateLocalMessages } from './local.js';
import type { TokenUsage, ProviderIdentity } from './ai.js';

const metadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const generationDiagnostics = {
  onAttempt: (provider: ProviderIdentity) =>
    console.error(
      `尝试来源：${provider.name} · ${provider.protocol} · ${provider.model}\n请求地址：${provider.endpoint}`,
    ),
  onFailure: (provider: ProviderIdentity, reason: string) =>
    console.error(`来源 ${provider.name} 失败：${reason}。`),
  onRoute: (description: string) => console.error(`网络路径：${description}`),
};
function countArgument(value: string): number {
  if (!/^[1-5]$/.test(value)) throw new InvalidArgumentError('请输入 1 到 5 的整数。');
  return Number(value);
}

interface Options {
  lang?: Language;
  count?: number;
  staged?: boolean;
  worktree?: boolean;
  json?: boolean;
  print?: boolean;
  pick?: number;
  copy?: boolean;
  hint?: string;
  local?: boolean;
  preview?: boolean;
  files?: boolean;
}

const program = new Command()
  .name('cmsg')
  .description(
    '从 Git 改动生成 4 条提交信息（2 English + 2 中文），可编辑后复制；无 AI 配置时使用本地规则。',
  )
  .version(metadata.version)
  .argument('[language]', '本次语言：both、zh / cn 或 en')
  .addOption(
    new Option('-l, --lang <language>', '本次提交信息语言').choices(['both', 'zh', 'cn', 'en']),
  )
  .addOption(
    new Option('-n, --count <number>', '候选总数，默认 4；双语时英文优先分配奇数条').argParser(
      countArgument,
    ),
  )
  .addOption(new Option('-s, --staged', '只分析暂存区').conflicts('worktree'))
  .addOption(
    new Option('-w, --worktree', '分析工作区相对 HEAD 的全部改动及未跟踪文件').conflicts('staged'),
  )
  .addOption(new Option('--json', '输出 JSON，供脚本使用').conflicts(['print', 'copy', 'pick']))
  .addOption(
    new Option('-p, --print', '只打印全部候选，不弹出选择菜单').conflicts(['json', 'copy', 'pick']),
  )
  .addOption(new Option('--pick <number>', '直接输出指定序号的候选').argParser(countArgument))
  .option('-c, --copy', '复制选中的候选；非交互环境须同时指定 --pick')
  .option('--hint <text>', '补充一句改动意图')
  .option('--local', '使用本地规则，无需 AI 配置、Key 或网络')
  .addOption(
    new Option('--preview', '预览待发送的文件范围和内容，不请求 AI').conflicts([
      'local',
      'copy',
      'pick',
      'print',
      'hint',
    ]),
  )
  .option('--files', '在 stderr 列出本次纳入的文件')
  .addHelpText(
    'after',
    '\n示例：\n  cmsg              生成 2 条英文 + 2 条中文，选择、编辑并复制\n  cmsg zh           本次全部中文（cn 也可）\n  cmsg en           本次全部英文\n  cmsg --preview    查看待发送内容，不请求 AI\n  cmsg -s --json    只根据暂存区生成 JSON\n  cmsg config --lang both --count 4  保存通用偏好\n  cmsg setup        配置 AI\n  cmsg setup --reset  备份旧 AI 配置后重新配置\n  cmsg test         用固定示例测试 AI，不读取仓库\n\n本工具不会执行 git add、commit 或 push。',
  )
  .action(async (language: string | undefined, options: Options) => {
    if (language === 'cn') language = 'zh';
    if ((options.lang as string) === 'cn') options.lang = 'zh';
    if (language && !['zh', 'en', 'both'].includes(language))
      throw new Error('语言只支持 both、zh / cn 或 en；查看用法：cmsg --help。');
    if (language && options.lang && language !== options.lang)
      throw new Error('语言参数冲突，请只指定一种语言。');
    if (!interactive && options.copy && !options.pick)
      throw new Error('非交互环境复制时请指定 --pick，例如 cmsg --pick 1 -c。');
    const started = performance.now();
    const preferences = options.preview
      ? { language: 'both' as const, count: 4 }
      : await loadPreferences();
    const config = options.local || options.preview ? null : await loadConfig();
    const generation = {
      language: (language ?? options.lang ?? preferences.language) as Language,
      count: options.count ?? preferences.count,
    };
    if (!config && options.hint)
      throw new Error('--hint 仅适用于 AI 模式；请运行 cmsg setup，或去掉 --hint 使用本地规则。');
    if (options.pick && options.pick > generation.count)
      throw new Error('--pick 不能超过候选数量。');
    console.error('正在读取 Git 改动…');
    const changes = await collectChanges(
      process.cwd(),
      options.staged ? 'staged' : options.worktree ? 'worktree' : 'auto',
      { metadataOnly: !config && !options.preview },
    );
    const label = changes.scope === 'staged' ? '暂存区' : '工作区预览（含未暂存及未跟踪文件）';
    console.error(
      `范围：${label} · ${changes.files.length} 个文件 · ${generation.language === 'both' ? 'English + 中文' : generation.language === 'zh' ? '中文' : 'English'} · ${generation.count} 条候选`,
    );
    const showFiles = () => {
      console.error(`仓库：${changes.root}`);
      console.error(
        changes.files
          .map(
            (file) =>
              `${file.status} ${file.previousPath ? JSON.stringify(file.previousPath) + ' -> ' : ''}${JSON.stringify(file.path)}`,
          )
          .join('\n'),
      );
    };
    if (options.files) showFiles();
    if (options.preview) {
      const inputBytes = Buffer.byteLength(changes.diff);
      console.log(
        options.json
          ? JSON.stringify(
              {
                scope: changes.scope,
                root: changes.root,
                files: changes.files,
                summarized: changes.summarized,
                inputBytes,
                diff: changes.diff,
              },
              null,
              2,
            )
          : `仓库：${changes.root}\n模型输入：${inputBytes} bytes（不含提示词）\n\n${changes.diff}`,
      );
      return;
    }
    if (!config)
      console.error('本地规则模式：仅根据文件操作生成，不调用 AI。可运行 cmsg setup 配置 AI。');
    if (changes.summarized)
      console.error(
        '已自动整理输入：保留全部文件变更，源码使用全文或片段，构建产物、锁文件、AGENTS.md、README.md 及测试文件仅保留元数据和统计。',
      );
    let usage: TokenUsage | undefined;
    let provider: ProviderIdentity | undefined;
    const requestMessages = async (hint?: string) => {
      if (!config) return generateLocalMessages(changes.files, generation);
      console.error(
        `正在请求 AI… 输入 ${(Buffer.byteLength(changes.diff) / 1024).toFixed(1)} KiB（不含提示词；非 token 数）`,
      );
      const { generateWithFallback } = await import('./ai.js');
      usage = undefined;
      provider = undefined;
      const result = await generateWithFallback(config, generation, changes.diff, {
        hint,
        ...generationDiagnostics,
      });
      usage = result.usage;
      provider = result.provider;
      console.error(`使用来源：${provider.name}`);
      if (usage)
        console.error(
          `Token（成功来源）：输入 ${usage.inputTokens ?? '未知'} · 输出 ${usage.outputTokens ?? '未知'} · 合计 ${usage.totalTokens ?? '未知'}`,
        );
      if (!usage) console.error('服务商未返回 token 用量。');
      return result.messages;
    };
    const messages = await requestMessages(options.hint);
    console.error(`生成完成，总用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            scope: changes.scope,
            source: config ? 'ai' : 'local',
            messages,
            languages: candidateLanguages(generation.language, generation.count),
            ...(usage ? { usage } : {}),
            ...(provider ? { provider } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (options.print || (!interactive && !options.pick)) {
      console.log(messages.map((message, index) => `${index + 1}. ${message}`).join('\n'));
      return;
    }
    let selected: string;
    if (options.pick) selected = messages[options.pick - 1]!;
    else {
      const { select, input } = await import('@inquirer/prompts');
      const { selectMessage } = await import('./selection.js');
      selected = await selectMessage(
        messages,
        { select, input, output: (text) => console.error(text) },
        {
          hint: options.hint,
          ...(config ? { regenerate: requestMessages } : {}),
          preview: showFiles,
        },
      );
    }
    console.log(selected);
    if (interactive || options.copy) {
      console.error('正在复制到剪贴板…');
      try {
        await copyToClipboard(selected);
      } catch (error) {
        throw new Error(
          `消息已输出，但${error instanceof Error ? error.message : '剪贴板不可用。'}请复制上方消息，或用 cmsg --print。`,
          { cause: error },
        );
      }
      console.error('已复制到剪贴板。');
    }
  });

program
  .command('setup')
  .description('交互式配置 AI 服务及默认语言')
  .option('--reset', '备份原 AI 配置后重新配置（用于恢复损坏配置）')
  .action(async (options: { reset?: boolean }) => {
    if (!interactive)
      throw new Error(
        '请在交互式终端运行 cmsg setup；脚本可使用 CMSG_PROTOCOL、CMSG_BASE_URL、CMSG_API_KEY、CMSG_MODEL。',
      );
    await setupConfig(configPath(), undefined, options);
    console.log(
      `配置已保存：${configPath()}\n${options.reset ? '原配置如存在，已备份为同目录的 .bak 文件。\n' : ''}运行 cmsg test 测试连接，或进入 Git 仓库运行 cmsg。`,
    );
  });

program
  .command('test')
  .description('用固定示例测试 AI 连接及候选格式，不读取仓库改动')
  .option('--json', '输出 JSON，供脚本使用')
  .action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals<{ json?: boolean }>();
    const config = await loadConfig();
    if (!config) throw new Error('尚未配置 AI，请先在终端运行 cmsg setup。');
    console.error('按优先级发送固定示例，成功即停止，不读取仓库改动。');
    const started = performance.now();
    const { generateWithFallback } = await import('./ai.js');
    const result = await generateWithFallback(
      config,
      { language: 'en', count: 1 },
      'diff --git a/example.txt b/example.txt\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+Hello world\n',
      generationDiagnostics,
    );
    console.error(
      `测试通过：连接和候选格式有效，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`,
    );
    console.log(
      options.json
        ? JSON.stringify(
            {
              ...result.provider,
              provider: result.provider,
              messages: result.messages,
              ...(result.usage ? { usage: result.usage } : {}),
            },
            null,
            2,
          )
        : result.messages[0],
    );
  });

program
  .command('config')
  .description('查看配置或保存通用偏好（隐藏 API Key）')
  .option('--reset-preferences', '备份通用偏好并恢复双语 4 条默认值')
  .action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals<{
      lang?: Language | 'cn';
      count?: number;
      resetPreferences?: boolean;
    }>();
    if (options.lang || options.count || options.resetPreferences) {
      const previous = options.resetPreferences
        ? { language: 'both' as const, count: 4 }
        : await loadPreferences();
      if (options.resetPreferences) await backupConfig(`${configPath()}.preferences.json`);
      const preferences = {
        language: options.lang === 'cn' ? ('zh' as const) : (options.lang ?? previous.language),
        count: options.count ?? previous.count,
      };
      await savePreferences(preferences);
      console.log(
        `通用偏好已保存：${configPath()}.preferences.json\n${JSON.stringify(preferences, null, 2)}`,
      );
      return;
    }
    const preferences = await loadPreferences();
    const config = await loadConfig();
    console.log(`配置文件：${configPath()}`);
    console.log(
      `通用偏好：${JSON.stringify(preferences)}（独立保存；旧 AI 配置的 language/count 不再决定生成默认值）`,
    );
    if (!config) {
      console.log('尚未配置 AI，生成时使用本地规则；可运行 cmsg setup 启用 AI。');
      return;
    }
    console.log(
      'AI 来源按以下优先级尝试（含付费来源时，回退可能产生费用）：\n' +
        JSON.stringify(
          {
            providers: config.map((p) => ({ ...p, apiKey: p.apiKey ? '[已设置]' : '[未设置]' })),
            ...preferences,
          },
          null,
          2,
        ),
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  if ((error as Error).name === 'ExitPromptError') {
    console.error('已取消。');
    process.exitCode = 130;
  } else {
    console.error(`错误：${error instanceof Error ? error.message : '执行失败。'}`);
    process.exitCode = 1;
  }
}
