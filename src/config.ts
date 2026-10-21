import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Language = 'zh' | 'en' | 'both';
export interface Preferences {
  language: Language;
  count: number;
}

export function candidateLanguages(language: Language, count: number): ('en' | 'zh')[] {
  return Array.from({ length: count }, (_, i) =>
    language === 'both' ? (i < Math.ceil(count / 2) ? 'en' : 'zh') : language,
  );
}

function validatePreferences(value: unknown): Preferences {
  const data = value as Partial<Preferences> | null;
  if (!data || !['en', 'zh', 'both'].includes(data.language ?? ''))
    throw new Error('配置语言只支持 zh、en 或 both。');
  if (!Number.isInteger(data.count) || data.count! < 1 || data.count! > 5)
    throw new Error('候选数量必须是 1 到 5 的整数。');
  return { language: data.language!, count: data.count! };
}

export async function loadPreferences(path = configPath()): Promise<Preferences> {
  try {
    return validatePreferences(JSON.parse(await readFile(`${path}.preferences.json`, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { language: 'both', count: 4 };
    throw new Error('无法读取通用偏好；可运行 cmsg config --reset-preferences 恢复默认值。', {
      cause: error,
    });
  }
}

export async function savePreferences(value: Preferences, path = configPath()): Promise<void> {
  await saveJson(validatePreferences(value), `${path}.preferences.json`);
}

export async function backupConfig(path = configPath()): Promise<string | null> {
  const backup = `${path}.${randomUUID()}.bak`;
  try {
    await copyFile(path, backup, constants.COPYFILE_EXCL);
    return backup;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export type Protocol = 'chat-completions' | 'responses';
export type ProviderProxyMode = 'auto' | 'proxy' | 'direct';
export interface AIConfig {
  protocol: Protocol;
  endpoint: string;
  apiKey: string;
  model: string;
  proxyMode?: ProviderProxyMode;
}
export interface Config extends AIConfig, Preferences {}
export interface AIProvider extends AIConfig {
  name: string;
  timeoutMs: number;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CMSG_CONFIG) return env.CMSG_CONFIG;
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' ? env.APPDATA : undefined) ||
    join(homedir(), '.config');
  return join(base, 'commitpick', 'config.json');
}

export function normalizeEndpoint(value: string, protocol?: Protocol): string {
  if (protocol !== undefined && protocol !== 'chat-completions' && protocol !== 'responses')
    throw new Error('AI 协议只支持 responses 或 chat-completions。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('AI 地址无效，请输入完整的 http:// 或 https:// 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('AI 地址必须使用 http 或 https。');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('AI 地址不能包含凭据、查询参数或片段；Key 请单独填写。');
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/messages'))
    throw new Error('不支持 Messages 协议，请使用 Responses 或 Chat Completions 接口。');
  const selected = protocol ?? (path.endsWith('/responses') ? 'responses' : 'chat-completions');
  const base = (path || '/v1').replace(/\/(?:chat\/completions|responses)$/, '');
  url.pathname = `${base}/${selected === 'responses' ? 'responses' : 'chat/completions'}`;
  return url.toString();
}

function validateConfig(value: unknown): AIConfig {
  if (!value || typeof value !== 'object') throw new Error('配置必须是 JSON 对象。');
  const data = value as Record<string, unknown>;
  if (typeof data.endpoint !== 'string' || typeof data.model !== 'string' || !data.model.trim())
    throw new Error('配置缺少 AI 地址或模型名，请运行 cmsg setup。');
  if (data.apiKey !== undefined && typeof data.apiKey !== 'string')
    throw new Error('配置中的 apiKey 必须是字符串。');
  if (
    data.proxyMode !== undefined &&
    !['auto', 'proxy', 'direct'].includes(data.proxyMode as string)
  )
    throw new Error('配置中的 proxyMode 只支持 auto、proxy 或 direct。');
  const endpoint = normalizeEndpoint(data.endpoint, data.protocol as Protocol | undefined);
  return {
    protocol: endpoint.endsWith('/responses') ? 'responses' : 'chat-completions',
    endpoint,
    apiKey: (data.apiKey as string | undefined)?.trim() ?? '',
    model: data.model.trim(),
    ...(data.proxyMode !== undefined ? { proxyMode: data.proxyMode as ProviderProxyMode } : {}),
  };
}

function validateProviders(value: unknown): AIProvider[] {
  if (!Array.isArray(value)) throw new Error('配置中的 providers 必须是按优先级排列的数组。');
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('每个 AI 来源必须是配置对象。');
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(name))
      throw new Error('来源名称需要 1–40 个英文字母、数字、点、下划线或连字符。');
    if (names.has(name)) throw new Error('AI 来源名称不能重复。');
    names.add(name);
    const timeoutMs = entry.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new Error('来源超时 timeoutMs 必须是 1–120000 的整数（毫秒）。');
    return { name, ...validateConfig(entry), timeoutMs };
  });
}

export async function loadConfig(
  path = configPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AIProvider[] | null> {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('配置必须是 JSON 对象。');
    saved = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        `无法读取配置 ${path}；请检查文件权限，或运行 cmsg setup --reset 备份并重新配置。`,
        { cause: error },
      );
  }
  if (!Object.keys(saved).length && !env.CMSG_BASE_URL && !env.CMSG_MODEL) return null;
  const entries = Object.hasOwn(saved, 'providers')
    ? saved.providers
    : [{ ...saved, name: 'default' }];
  if (!Array.isArray(entries)) throw new Error('配置中的 providers 必须是数组。');
  if (!entries.length && !env.CMSG_BASE_URL && !env.CMSG_MODEL) return null;
  const overridden =
    env.CMSG_PROTOCOL || env.CMSG_BASE_URL || env.CMSG_MODEL || env.CMSG_API_KEY !== undefined;
  // Explicit environment overrides select one temporary provider, never a hidden paid fallback.
  const providers = validateProviders(
    overridden
      ? [
          {
            ...(entries[0] ?? { name: 'default' }),
            ...(env.CMSG_PROTOCOL ? { protocol: env.CMSG_PROTOCOL } : {}),
            ...(env.CMSG_BASE_URL ? { endpoint: env.CMSG_BASE_URL } : {}),
            ...(env.CMSG_MODEL ? { model: env.CMSG_MODEL } : {}),
            ...(env.CMSG_API_KEY !== undefined ? { apiKey: env.CMSG_API_KEY } : {}),
          },
        ]
      : entries,
  );
  return providers.length ? providers : null;
}

export async function saveConfig(
  config: AIConfig | AIProvider[],
  path = configPath(),
): Promise<void> {
  const providers = validateProviders(
    Array.isArray(config) ? config : [{ ...config, name: 'default' }],
  );
  await saveJson({ providers }, path);
}

async function saveJson(value: unknown, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
