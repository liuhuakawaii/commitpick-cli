import { parseMessages } from './ai.js';

interface SelectionUI {
  select: (options: {
    message: string;
    choices: { name: string; value: string }[];
  }) => Promise<string>;
  input: (options: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }) => Promise<string>;
  output: (text: string) => void;
}

/** Owns candidate editing and explicit regeneration; no clipboard or Git mutations. */
export async function selectMessage(
  initial: string[],
  ui: SelectionUI,
  options: {
    hint?: string;
    regenerate?: (hint?: string) => Promise<string[]>;
    preview?: () => void;
  } = {},
): Promise<string> {
  let messages = [...initial];
  let hint = options.hint;
  for (;;) {
    const action = await ui.select({
      message: '选择提交信息（回车复制，或选择下方操作；Ctrl+C 退出）',
      choices: [
        ...messages.map((message, i) => ({ name: message, value: `copy:${i}` })),
        ...messages.map((_, i) => ({ name: `编辑第 ${i + 1} 条`, value: `edit:${i}` })),
        ...(options.regenerate
          ? [
              { name: '补充意图后重新生成（再次请求 AI）', value: 'hint' },
              { name: '重新生成（再次请求 AI）', value: 'retry' },
            ]
          : []),
        ...(options.preview ? [{ name: '查看本次文件范围', value: 'preview' }] : []),
      ],
    });
    if (action.startsWith('copy:')) return messages[Number(action.slice(5))]!;
    if (action.startsWith('edit:')) {
      const index = Number(action.slice(5));
      const edited = await ui.input({
        message: '编辑提交信息',
        default: messages[index],
        validate: (value) => {
          try {
            parseMessages(JSON.stringify({ messages: [value] }), 1);
            return true;
          } catch {
            return '请输入不超过 100 字符的单行 Conventional Commit，例如 fix(auth): reuse pending request';
          }
        },
      });
      messages[index] = parseMessages(JSON.stringify({ messages: [edited] }), 1)[0]!;
    } else if (action === 'preview') options.preview?.();
    else if (options.regenerate && (action === 'hint' || action === 'retry')) {
      if (action === 'hint') hint = await ui.input({ message: '补充改动意图', default: hint });
      try {
        messages = await options.regenerate(hint);
      } catch (error) {
        ui.output(
          `重新生成失败，保留原候选：${error instanceof Error ? error.message : '请求失败'}`,
        );
      }
    }
  }
}
