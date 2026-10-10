import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Language = 'zh' | 'en';
export interface Config {
  endpoint: string;
  apiKey: string;
  model: string;
  language: Language;
  count: number;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CMSG_CONFIG) return env.CMSG_CONFIG;
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' ? env.APPDATA : undefined) ||
    join(homedir(), '.config');
  return join(base, 'commitpick', 'config.json');
}

export function normalizeEndpoint(value: string): string {
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
  if (path.endsWith('/responses') || path.endsWith('/messages'))
    throw new Error('目前支持 Chat Completions 接口，请使用对应的 Base URL。');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path || '/v1'}/chat/completions`;
  return url.toString();
}

function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new Error('配置必须是 JSON 对象。');
  const data = value as Record<string, unknown>;
  if (typeof data.endpoint !== 'string' || typeof data.model !== 'string' || !data.model.trim())
    throw new Error('配置缺少 AI 地址或模型名，请运行 cmsg setup。');
  if (data.apiKey !== undefined && typeof data.apiKey !== 'string')
    throw new Error('配置中的 apiKey 必须是字符串。');
  if (data.language !== 'zh' && data.language !== 'en')
    throw new Error('配置语言只支持 zh 或 en。');
  if (!Number.isInteger(data.count) || Number(data.count) < 1 || Number(data.count) > 5)
    throw new Error('候选数量必须是 1 到 5 的整数。');
  return {
    endpoint: normalizeEndpoint(data.endpoint),
    apiKey: (data.apiKey as string | undefined)?.trim() ?? '',
    model: data.model.trim(),
    language: data.language,
    count: Number(data.count),
  };
}

export async function loadConfig(
  path = configPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config | null> {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('配置必须是 JSON 对象。');
    saved = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`无法读取配置 ${path}；请检查 JSON 格式及文件权限。`, { cause: error });
  }
  if (!Object.keys(saved).length && !env.CMSG_BASE_URL && !env.CMSG_MODEL) return null;
  return validateConfig({
    language: 'en',
    count: 3,
    ...saved,
    ...(env.CMSG_BASE_URL ? { endpoint: env.CMSG_BASE_URL } : {}),
    ...(env.CMSG_MODEL ? { model: env.CMSG_MODEL } : {}),
    ...(env.CMSG_API_KEY !== undefined ? { apiKey: env.CMSG_API_KEY } : {}),
  });
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  const valid = validateConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(valid, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
