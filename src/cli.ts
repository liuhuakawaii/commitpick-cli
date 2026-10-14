#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, Option, InvalidArgumentError } from 'commander';
import { configPath, loadConfig, type Language } from './config.js';
import { collectChanges } from './git.js';
import { setupConfig } from './setup.js';
import { copyToClipboard } from './clipboard.js';
import { generateLocalMessages } from './local.js';

const metadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
}

const program = new Command()
  .name('cmsg')
  .description('从 Git 改动生成 3 条标准提交信息，选择后复制；未配置 AI 时使用本地规则。')
  .version(metadata.version)
  .argument('[language]', '本次语言：zh 或 en')
  .addOption(new Option('-l, --lang <language>', '本次提交信息语言').choices(['zh', 'en']))
  .addOption(new Option('-n, --count <number>', '候选数量，默认 3').argParser(countArgument))
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
  .addHelpText(
    'after',
    '\n示例：\n  cmsg setup        配置协议、地址、Key、模型和默认语言\n  cmsg config       查看生效配置（隐藏 Key）\n  cmsg test         用固定示例测试 AI，不读取仓库\n  cmsg              生成 3 条候选，方向键选择并复制\n  cmsg zh           本次生成中文消息\n  cmsg en           本次生成英文消息\n  cmsg -s --json    只根据暂存区生成 JSON\n  cmsg --pick 2 -c  复制第 2 条候选\n\n本工具不会执行 git add、commit 或 push。',
  )
  .action(async (language: string | undefined, options: Options) => {
    if (language && language !== 'zh' && language !== 'en')
      throw new Error('语言只支持 zh 或 en；查看用法：cmsg --help。');
    if (language && options.lang && language !== options.lang)
      throw new Error('语言参数冲突，请只指定一种语言。');
    if (!interactive && options.copy && !options.pick)
      throw new Error('非交互环境复制时请指定 --pick，例如 cmsg --pick 1 -c。');
    const config = options.local ? null : await loadConfig();
    const generation = {
      language: (language ?? options.lang ?? config?.language ?? 'en') as Language,
      count: options.count ?? config?.count ?? 3,
    };
    if (!config && options.hint)
      throw new Error('--hint 仅适用于 AI 模式；请运行 cmsg setup，或去掉 --hint 使用本地规则。');
    if (options.pick && options.pick > generation.count)
      throw new Error('--pick 不能超过候选数量。');
    const changes = await collectChanges(
      process.cwd(),
      options.staged ? 'staged' : options.worktree ? 'worktree' : 'auto',
      { metadataOnly: !config },
    );
    const label = changes.scope === 'staged' ? '暂存区' : '工作区预览（含未暂存及未跟踪文件）';
    console.error(
      `范围：${label} · ${generation.language === 'zh' ? '中文' : 'English'} · ${generation.count} 条候选`,
    );
    if (!config)
      console.error('本地规则模式：仅根据文件操作生成，不调用 AI。可运行 cmsg setup 配置 AI。');
    if (changes.summarized)
      console.error(
        '改动较大，已自动整理：保留全部文件变更，源码使用全文或片段，构建产物及锁文件仅保留统计。',
      );
    const started = performance.now();
    let messages: string[];
    if (config) {
      const { generateMessages } = await import('./ai.js');
      messages = await generateMessages({ ...config, ...generation }, changes.diff, {
        hint: options.hint,
      });
    } else messages = generateLocalMessages(changes.files, generation);
    console.error(`生成完成，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
    if (options.json) {
      console.log(
        JSON.stringify(
          { scope: changes.scope, source: config ? 'ai' : 'local', messages },
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
      const { select } = await import('@inquirer/prompts');
      selected = await select({
        message: '选择提交信息（回车复制，Ctrl+C 退出）',
        choices: messages.map((message) => ({ name: message, value: message })),
      });
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
  .action(async () => {
    if (!interactive)
      throw new Error(
        '请在交互式终端运行 cmsg setup；脚本可使用 CMSG_PROTOCOL、CMSG_BASE_URL、CMSG_API_KEY、CMSG_MODEL。',
      );
    await setupConfig();
    console.log(`配置已保存：${configPath()}\n现在进入 Git 仓库运行 cmsg 即可。`);
  });

program
  .command('test')
  .description('用固定示例测试 AI 连接及候选格式，不读取仓库改动')
  .option('--json', '输出 JSON，供脚本使用')
  .action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals<{ json?: boolean }>();
    const config = await loadConfig();
    if (!config) throw new Error('尚未配置 AI，请先在终端运行 cmsg setup。');
    console.error(`测试：${config.protocol} · ${config.model}\n请求地址：${config.endpoint}`);
    console.error('发送固定示例，不读取仓库改动。');
    const started = performance.now();
    const { generateMessages } = await import('./ai.js');
    const messages = await generateMessages(
      { ...config, count: 1 },
      'diff --git a/example.txt b/example.txt\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+Hello world\n',
    );
    console.error(
      `测试通过：连接和候选格式有效，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`,
    );
    console.log(
      options.json
        ? JSON.stringify(
            { protocol: config.protocol, endpoint: config.endpoint, model: config.model, messages },
            null,
            2,
          )
        : messages[0],
    );
  });

program
  .command('config')
  .description('查看当前生效配置（隐藏 API Key）')
  .action(async () => {
    const config = await loadConfig();
    console.log(`配置文件：${configPath()}`);
    if (!config) {
      console.log('尚未配置 AI，生成时使用本地规则；可运行 cmsg setup 启用 AI。');
      return;
    }
    console.log(
      JSON.stringify({ ...config, apiKey: config.apiKey ? '[已设置]' : '[未设置]' }, null, 2),
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
