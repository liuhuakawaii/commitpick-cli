import {
  configPath,
  loadConfig,
  normalizeEndpoint,
  saveConfig,
  backupConfig,
  savePreferences,
  loadPreferences,
  type AIProvider,
  type Language,
  type ProviderProxyMode,
  type Protocol,
} from './config.js';

interface Prompts {
  input: (options: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }) => Promise<string>;
  password: (options: {
    message: string;
    mask: string;
    validate?: (value: string) => boolean | string;
  }) => Promise<string>;
  select: (options: {
    message: string;
    default: string;
    choices: { name: string; value: string }[];
  }) => Promise<string>;
}

const freeEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
const freeModel = 'openrouter/free';

export async function setupConfig(
  path = configPath(),
  prompts?: Prompts,
  options: { reset?: boolean } = {},
): Promise<AIProvider[]> {
  const ui = prompts ?? (await import('@inquirer/prompts'));
  // Setup edits persisted configuration only; temporary environment overrides are never saved.
  const providers = options.reset ? [] : ((await loadConfig(path, {})) ?? []);
  const action = providers.length
    ? await ui.select({
        message: '配置操作（来源按列表顺序回退，付费来源会按服务商规则计费）',
        default: 'edit',
        choices: [
          { name: '编辑已有来源', value: 'edit' },
          { name: '添加来源（放在末尾）', value: 'add' },
          { name: '调整优先级', value: 'order' },
          { name: '移除来源（先备份）', value: 'remove' },
        ],
      })
    : 'add';
  if (action === 'order') {
    const remaining = [...providers];
    const ordered: AIProvider[] = [];
    while (remaining.length > 1) {
      const name = await ui.select({
        message: `选择第 ${ordered.length + 1} 优先级（失败后尝试下一项）`,
        default: remaining[0]!.name,
        choices: remaining.map((p) => ({ name: `${p.name} · ${p.model}`, value: p.name })),
      });
      const index = remaining.findIndex((p) => p.name === name);
      if (index < 0) throw new Error('所选来源不存在。');
      ordered.push(remaining.splice(index, 1)[0]!);
    }
    ordered.push(...remaining);
    await saveConfig(ordered, path);
    return ordered;
  }
  let index = -1;
  if (action === 'edit' || action === 'remove') {
    const name =
      providers.length === 1
        ? providers[0]!.name
        : await ui.select({
            message: action === 'edit' ? '选择要编辑的来源' : '选择要移除的来源',
            default: providers[0]!.name,
            choices: providers.map((p) => ({ name: `${p.name} · ${p.model}`, value: p.name })),
          });
    index = providers.findIndex((p) => p.name === name);
    if (index < 0) throw new Error('所选来源不存在。');
  }
  if (action === 'remove') {
    const remaining = providers.filter((_, i) => i !== index);
    await backupConfig(path);
    await saveConfig(remaining, path);
    return remaining;
  }
  const previous = providers[index];
  const preferences = await loadPreferences(path);
  const source = await ui.select({
    message: 'AI 来源',
    default:
      !previous || (previous.endpoint === freeEndpoint && previous.model === freeModel)
        ? 'openrouter-free'
        : 'custom',
    choices: [
      {
        name: 'OpenRouter 免费云端（需免费 API Key，有额度限制，无需本地部署）',
        value: 'openrouter-free',
      },
      { name: '自定义 API（中转站、官方接口或本地服务）', value: 'custom' },
    ],
  });
  const free = source === 'openrouter-free';
  const validateName = (value: string) => {
    const name = value.trim();
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(name))
      return '名称需为 1–40 个英文字母、数字、点、下划线或连字符。';
    return !providers.some((p, i) => i !== index && p.name === name) || '来源名称不能重复。';
  };
  const name = (
    await ui.input({
      message: '来源名称（用于区分配置）',
      default: previous?.name ?? `provider-${providers.length + 1}`,
      validate: validateName,
    })
  ).trim();
  const nameValidation = validateName(name);
  if (nameValidation !== true) throw new Error(nameValidation);
  const protocol: Protocol = free
    ? 'chat-completions'
    : ((await ui.select({
        message: 'AI 接口协议（按服务商文档选择）',
        default: previous?.protocol ?? 'responses',
        choices: [
          { name: 'Responses（Codex / Responses 兼容中转站）', value: 'responses' },
          { name: 'Chat Completions（聊天补全兼容接口）', value: 'chat-completions' },
        ],
      })) as Protocol);
  const proxyMode = (await ui.select({
    message: '网络连接方式（失败时按当前配置回退）',
    default: previous?.proxyMode ?? 'auto',
    choices: [
      { name: '自动：环境代理 → 系统代理 → 直连', value: 'auto' },
      { name: '强制代理：只使用环境或系统代理', value: 'proxy' },
      { name: '强制直连：不使用任何代理', value: 'direct' },
    ],
  })) as ProviderProxyMode;
  const address = free
    ? freeEndpoint
    : await ui.input({
        message: 'AI 地址（域名、Base URL 或完整接口地址）',
        default: previous
          ? normalizeEndpoint(previous.endpoint, protocol)
          : 'https://api.openai.com/v1',
        validate: (value) => {
          try {
            normalizeEndpoint(value, protocol);
            return true;
          } catch (error) {
            return (error as Error).message;
          }
        },
      });
  const endpoint = normalizeEndpoint(address, protocol);
  // A relay credential must never become the default credential for the free cloud service.
  const savedKey =
    previous && new URL(previous.endpoint).origin === new URL(endpoint).origin
      ? previous.apiKey
      : '';
  const keyValue = (value: string) => (value.trim() === '-' ? '' : value.trim() || savedKey);
  const validateKey = (value: string) =>
    !free ||
    !!keyValue(value) ||
    'OpenRouter 免费云端需要 API Key，请在 https://openrouter.ai/settings/keys 创建。';
  const key = await ui.password({
    message: free
      ? `OpenRouter API Key（https://openrouter.ai/settings/keys${savedKey ? '；回车保留' : '；必填'}）`
      : savedKey
        ? 'API Key（回车保留，输入 - 清空）'
        : 'API Key（本地无认证服务可留空）',
    mask: '*',
    validate: validateKey,
  });
  const keyValidation = validateKey(key);
  if (keyValidation !== true) throw new Error(keyValidation);
  const model = free
    ? freeModel
    : await ui.input({
        message: '模型名（填写服务商提供的准确名称）',
        default: previous?.model,
        validate: (value) => value.trim().length > 0 || '模型名不能为空。',
      });
  const timeout = await ui.input({
    message: '请求超时（秒，失败后尝试下一来源）',
    default: String((previous?.timeoutMs ?? 30_000) / 1000),
    validate: (value) =>
      (/^\d+(?:\.\d{1,3})?$/.test(value.trim()) && Number(value) > 0 && Number(value) <= 120) ||
      '超时需要大于 0 且不超过 120 秒，最多三位小数。',
  });
  const language = await ui.select({
    message: '默认提交信息语言',
    default: preferences.language,
    choices: [
      { name: 'English + 简体中文（默认各 2 条）', value: 'both' },
      { name: 'English', value: 'en' },
      { name: '简体中文', value: 'zh' },
    ],
  });
  const config: AIProvider = {
    name,
    protocol,
    endpoint,
    apiKey: keyValue(key),
    model: model.trim(),
    timeoutMs: Math.round(Number(timeout) * 1000),
    ...(proxyMode !== 'auto' ? { proxyMode } : {}),
  };
  const updated = [...providers];
  if (index < 0) updated.push(config);
  else updated[index] = config;
  if (options.reset) await backupConfig(path);
  await saveConfig(updated, path);
  await savePreferences({ language: language as Language, count: preferences.count }, path);
  return updated;
}
