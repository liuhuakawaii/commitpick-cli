import {
  configPath,
  loadConfig,
  normalizeEndpoint,
  saveConfig,
  type Config,
  type Language,
} from './config.js';

interface Prompts {
  input: (options: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }) => Promise<string>;
  password: (options: { message: string; mask: string }) => Promise<string>;
  select: (options: {
    message: string;
    default: Language;
    choices: { name: string; value: Language }[];
  }) => Promise<Language>;
}

export async function setupConfig(path = configPath(), prompts?: Prompts): Promise<Config> {
  const ui = prompts ?? (await import('@inquirer/prompts'));
  // Setup edits persisted configuration only; temporary environment overrides are never saved.
  const previous = await loadConfig(path, {});
  const address = await ui.input({
    message: 'AI 地址（域名、Base URL 或完整 chat/completions 地址）',
    default: previous?.endpoint ?? 'https://api.openai.com/v1',
    validate: (value) => {
      try {
        normalizeEndpoint(value);
        return true;
      } catch (error) {
        return (error as Error).message;
      }
    },
  });
  const key = await ui.password({
    message: previous?.apiKey
      ? 'API Key（回车保留，输入 - 清空）'
      : 'API Key（本地无认证服务可留空）',
    mask: '*',
  });
  const model = await ui.input({
    message: '模型名（填写服务商提供的准确名称）',
    default: previous?.model,
    validate: (value) => value.trim().length > 0 || '模型名不能为空。',
  });
  const language = await ui.select({
    message: '默认提交信息语言',
    default: previous?.language ?? 'en',
    choices: [
      { name: 'English', value: 'en' },
      { name: '简体中文', value: 'zh' },
    ],
  });
  const config: Config = {
    endpoint: normalizeEndpoint(address),
    apiKey: key.trim() === '-' ? '' : key.trim() || previous?.apiKey || '',
    model: model.trim(),
    language,
    count: previous?.count ?? 3,
  };
  await saveConfig(config, path);
  return config;
}
