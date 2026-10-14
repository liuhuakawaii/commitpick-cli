import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { EnvHttpProxyAgent } from 'undici';

const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export type ProxySource = 'environment' | 'windows-system' | 'direct';

export interface WindowsProxySettings {
  enabled?: boolean;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigUrl?: string;
}

export interface ProxyResolution {
  source: ProxySource;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  description: string;
}

interface ResolveProxyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readSystemProxy?: () => WindowsProxySettings | undefined;
}

function preferredEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name.toLowerCase()] ?? env[name];
}

function hasProxyEnvironment(env: NodeJS.ProcessEnv): boolean {
  return ['HTTP_PROXY', 'HTTPS_PROXY'].some((name) => preferredEnv(env, name) !== undefined);
}

function normalizeProxyUri(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('unsupported proxy protocol');
  return candidate;
}

function parseProxyServer(value: string | undefined): { httpProxy: string; httpsProxy: string } {
  if (!value?.trim()) return { httpProxy: '', httpsProxy: '' };
  const entries = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const keyed = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    keyed.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
  }
  try {
    if (!keyed.size) {
      const proxy = normalizeProxyUri(value);
      return { httpProxy: proxy, httpsProxy: proxy };
    }
    const httpProxy = normalizeProxyUri(keyed.get('http') ?? '');
    const httpsProxy = normalizeProxyUri(keyed.get('https') ?? '');
    return { httpProxy, httpsProxy };
  } catch (cause) {
    throw new Error('Windows 系统代理地址无效，请检查系统代理设置。', { cause });
  }
}

// Windows wildcard rules differ from NO_PROXY suffix rules. Match the current
// endpoint directly rather than converting a pattern into a broader bypass.
function bypassSystemProxy(url: URL, value: string | undefined): boolean {
  for (const raw of (value ?? '').split(/[;\s]+/)) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === '<local>') {
      if (!url.hostname.includes('.') && !isIP(url.hostname.replace(/^\[|\]$/g, ''))) return true;
      continue;
    }
    if (token.startsWith('<')) continue;
    const parts = token.match(/^(?:(https?:)\/\/)?([^/]+)\/?$/);
    if (!parts || (parts[1] && parts[1] !== url.protocol)) continue;
    const authority = parts[2]!;
    const hasPort = /:\d+$/.test(authority);
    const target = hasPort
      ? `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
      : url.hostname;
    const pattern = authority
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (new RegExp(`^${pattern}$`, 'i').test(target)) return true;
  }
  return false;
}

function displayProxy(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return '已配置代理';
  }
}

function readRegistryValue(output: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s+\\S+\\s+(.+?)\\s*$`, 'im');
  return output.match(pattern)?.[1];
}

export function readWindowsSystemProxy(): WindowsProxySettings | undefined {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const result = spawnSync(
    join(systemRoot, 'System32', 'reg.exe'),
    ['query', WINDOWS_INTERNET_SETTINGS],
    {
      encoding: 'utf8',
      timeout: 1_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return;
  const output = result.stdout;
  const enabled = readRegistryValue(output, 'ProxyEnable');
  const proxyServer = readRegistryValue(output, 'ProxyServer');
  const proxyOverride = readRegistryValue(output, 'ProxyOverride');
  const autoConfigUrl = readRegistryValue(output, 'AutoConfigURL');
  return {
    ...(enabled !== undefined ? { enabled: /^0x0*1$/i.test(enabled) || enabled === '1' } : {}),
    ...(proxyServer ? { proxyServer } : {}),
    ...(proxyOverride ? { proxyOverride } : {}),
    ...(autoConfigUrl ? { autoConfigUrl } : {}),
  };
}

export function resolveProxy(endpoint: string, options: ResolveProxyOptions = {}): ProxyResolution {
  const env = options.env ?? process.env;
  const noProxy = preferredEnv(env, 'NO_PROXY')?.trim() ?? '';
  const direct = (description: string): ProxyResolution => ({
    source: 'direct',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '*',
    description,
  });
  if (noProxy === '*') return direct('直连（NO_PROXY=*）');
  if (hasProxyEnvironment(env)) {
    const httpValue = preferredEnv(env, 'HTTP_PROXY');
    const httpsValue = preferredEnv(env, 'HTTPS_PROXY');
    const httpProxy = httpValue?.trim() ?? '';
    const httpsProxy = httpsValue?.trim() ?? httpProxy;
    return {
      source: 'environment',
      httpProxy,
      httpsProxy,
      noProxy,
      description: '环境变量代理（遵循 NO_PROXY）',
    };
  }

  const url = new URL(endpoint);
  if (['localhost', 'loopback', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname))
    return direct('直连（本机地址不经过系统代理）');
  const settings =
    (options.platform ?? process.platform) === 'win32'
      ? (options.readSystemProxy ?? readWindowsSystemProxy)()
      : undefined;
  const parsed =
    settings?.enabled === true
      ? parseProxyServer(settings.proxyServer)
      : { httpProxy: '', httpsProxy: '' };
  const proxy = url.protocol === 'https:' ? parsed.httpsProxy : parsed.httpProxy;
  if (proxy) {
    if (bypassSystemProxy(url, settings?.proxyOverride))
      return direct('直连（Windows 代理绕过规则）');
    const description = `Windows 系统代理 ${displayProxy(proxy)}${noProxy ? '（遵循 NO_PROXY）' : ''}`;
    return { source: 'windows-system', ...parsed, noProxy, description };
  }
  return direct(
    settings?.autoConfigUrl ? 'Windows PAC 未自动执行，当前直连' : '直连（未检测到适用的静态代理）',
  );
}

export function createProxyAgent(resolution: ProxyResolution): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: resolution.httpProxy,
    httpsProxy: resolution.httpsProxy,
    noProxy: resolution.noProxy,
  });
}
