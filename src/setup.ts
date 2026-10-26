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
          { name: '通用偏好（语言与数量）', value: 'preferences' },
          { name: '添加来源（放在末尾）', value: 'add' },
          { name: '调整优先级', value: 'order' },
          { name: '移除来源（先备份）', value: 'remove' },
        ],
      })
    : 'add';
  if (action === 'preferences') {
    const preferences = await loadPreferences(path);
    const language = await ui.select({
      message: '默认提交信息语言',
      default: preferences.language,
      choices: ['both', 'en', 'zh'].map((value) => ({ name: value, value })),
    });
    const count = await ui.input({
      message: '默认候选数量（1–5）',
      default: String(preferences.count),
      validate: (value) => /^[1-5]$/.test(value) || '请输入 1–5。',
    });
    await savePreferences({ language: language as Language, count: Number(count) }, path);
    return providers;
  }
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
  const field = previous
    ? await ui.select({
        message: '选择要编辑的字段',
        default: 'model',
        choices: [
          ['name', '来源名称'],
          ['protocol', '协议'],
          ['endpoint', 'AI 地址'],
          ['apiKey', 'API Key'],
          ['model', '模型名'],
          ['timeoutMs', '请求总超时'],
          ['connectTimeoutMs', '连接超时'],
          ['proxyMode', '网络代理'],
          ['outputMode', '输出格式'],
          ['all', '全部字段'],
        ].map(([value, name]) => ({ value: value!, name: name! })),
      })
    : 'all';
  const edit = (key: string) => field === 'all' || field === key;
  const validateName = (value: string) => {
    const name = value.trim();
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(name))
      return '名称需为 1–40 个英文字母、数字、点、下划线或连字符。';
    return !providers.some((p, i) => i !== index && p.name === name) || '来源名称不能重复。';
  };
  const name = edit('name')
    ? (
        await ui.input({
          message: '来源名称（用于区分配置）',
          default: previous?.name ?? `provider-${providers.length + 1}`,
          validate: validateName,
        })
      ).trim()
    : previous!.name;
  const nameValidation = validateName(name);
  if (nameValidation !== true) throw new Error(nameValidation);
  const protocol: Protocol = edit('protocol')
    ? ((await ui.select({
        message: 'AI 接口协议（按服务商文档选择）',
        default: previous?.protocol ?? 'responses',
        choices: [
          { name: 'Responses（Codex / Responses 兼容中转站）', value: 'responses' },
          { name: 'Chat Completions（聊天补全兼容接口）', value: 'chat-completions' },
        ],
      })) as Protocol)
    : previous!.protocol;
  const proxyMode = edit('proxyMode')
    ? ((await ui.select({
        message: '网络连接方式（失败时按当前配置回退）',
        default: previous?.proxyMode ?? 'auto',
        choices: [
          { name: '自动：环境代理 → 系统代理 → 直连', value: 'auto' },
          { name: '强制代理：只使用环境或系统代理', value: 'proxy' },
          { name: '强制直连：不使用任何代理', value: 'direct' },
        ],
      })) as ProviderProxyMode)
    : (previous?.proxyMode ?? 'auto');
  const address = edit('endpoint')
    ? await ui.input({
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
      })
    : normalizeEndpoint(previous!.endpoint, protocol);
  const endpoint = normalizeEndpoint(address, protocol);
  // Only retain credentials when editing within the same origin.
  const savedKey =
    previous && new URL(previous.endpoint).origin === new URL(endpoint).origin
      ? previous.apiKey
      : '';
  const keyValue = (value: string) => (value.trim() === '-' ? '' : value.trim() || savedKey);
  const key =
    edit('apiKey') || (previous && new URL(previous.endpoint).origin !== new URL(endpoint).origin)
      ? await ui.password({
          message: savedKey
            ? 'API Key（回车保留，输入 - 清空）'
            : 'API Key（本地无认证服务可留空）',
          mask: '*',
        })
      : savedKey;
  const model = edit('model')
    ? await ui.input({
        message: '模型名（填写服务商提供的准确名称）',
        default: previous?.model,
        validate: (value) => value.trim().length > 0 || '模型名不能为空。',
      })
    : previous!.model;
  const timeout = edit('timeoutMs')
    ? await ui.input({
        message: '请求超时（秒，失败后尝试下一来源）',
        default: String((previous?.timeoutMs ?? 60_000) / 1000),
        validate: (value) =>
          (/^\d+(?:\.\d{1,3})?$/.test(value.trim()) && Number(value) > 0 && Number(value) <= 120) ||
          '超时需要大于 0 且不超过 120 秒，最多三位小数。',
      })
    : String(previous!.timeoutMs / 1000);
  const connectTimeout = edit('connectTimeoutMs')
    ? await ui.input({
        message: '连接超时（毫秒）',
        default: String(previous?.connectTimeoutMs ?? 5000),
        validate: (value) =>
          (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 120000) ||
          '请输入 1–120000 的整数。',
      })
    : undefined;
  const outputMode = edit('outputMode')
    ? await ui.select({
        message: '输出格式',
        default: previous?.outputMode ?? 'text',
        choices: [
          { name: '提示词约束 JSON（通用兼容）', value: 'text' },
          { name: 'JSON Schema（需服务商支持）', value: 'json-schema' },
        ],
      })
    : previous?.outputMode;
  const config: AIProvider = {
    ...previous,
    ...(connectTimeout !== undefined ? { connectTimeoutMs: Number(connectTimeout) } : {}),
    ...(outputMode !== undefined ? { outputMode: outputMode as 'text' | 'json-schema' } : {}),
    name,
    protocol,
    endpoint,
    apiKey: keyValue(key),
    model: model.trim(),
    timeoutMs: Math.round(Number(timeout) * 1000),
    ...(proxyMode !== 'auto' || previous?.proxyMode !== undefined ? { proxyMode } : {}),
  };
  const updated = [...providers];
  if (index < 0) updated.push(config);
  else updated[index] = config;
  if (options.reset) await backupConfig(path);
  await saveConfig(updated, path);
  return updated;
}
