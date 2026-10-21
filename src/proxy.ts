import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { EnvHttpProxyAgent } from 'undici';
import type { ProviderProxyMode } from './config.js';

const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export type ProxySource = 'environment' | 'windows-system' | 'direct';
export type ProxyMode = ProviderProxyMode | 'system';

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

export interface ResolveProxyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readSystemProxy?: () => WindowsProxySettings | undefined;
}

function preferredEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name.toLowerCase()] ?? env[name];
}

function hasProxyEnvironment(env: NodeJS.ProcessEnv): boolean {
  return ['HTTP_PROXY', 'HTTPS_PROXY'].some((name) => {
    const value = preferredEnv(env, name);
    return value !== undefined && value.trim() !== '';
  });
}

function proxyMode(env: NodeJS.ProcessEnv): ProxyMode {
  const value = preferredEnv(env, 'CMSG_PROXY_MODE')?.trim().toLowerCase() || 'auto';
  if (value === 'auto' || value === 'proxy' || value === 'direct' || value === 'system')
    return value;
  throw new Error('CMSG_PROXY_MODE 只支持 auto、proxy、direct 或 system。');
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

function directResolution(description: string): ProxyResolution {
  return {
    source: 'direct',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '*',
    description,
  };
}

function systemResolution(
  endpoint: string,
  env: NodeJS.ProcessEnv,
  options: ResolveProxyOptions,
): ProxyResolution | undefined {
  const url = new URL(endpoint);
  if (['localhost', 'loopback', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname))
    return;
  const settings =
    (options.platform ?? process.platform) === 'win32'
      ? (options.readSystemProxy ?? readWindowsSystemProxy)()
      : undefined;
  const parsed =
    settings?.enabled === true
      ? parseProxyServer(settings.proxyServer)
      : { httpProxy: '', httpsProxy: '' };
  const proxy = url.protocol === 'https:' ? parsed.httpsProxy : parsed.httpProxy;
  if (!proxy || bypassSystemProxy(url, settings?.proxyOverride)) return;
  const noProxy = preferredEnv(env, 'NO_PROXY')?.trim() ?? '';
  const description = `Windows 系统代理 ${displayProxy(proxy)}${noProxy ? '（遵循 NO_PROXY）' : ''}`;
  return { source: 'windows-system', ...parsed, noProxy, description };
}

export function resolveProxyRoutes(
  endpoint: string,
  options?: ResolveProxyOptions,
): ProxyResolution[];
export function resolveProxyRoutes(
  endpoint: string,
  providerMode: ProviderProxyMode,
  options?: ResolveProxyOptions,
): ProxyResolution[];
export function resolveProxyRoutes(
  endpoint: string,
  providerModeOrOptions?: ProviderProxyMode | ResolveProxyOptions,
  providedOptions: ResolveProxyOptions = {},
): ProxyResolution[] {
  const providerMode =
    typeof providerModeOrOptions === 'string' ? providerModeOrOptions : undefined;
  const options =
    typeof providerModeOrOptions === 'string' ? providedOptions : (providerModeOrOptions ?? {});
  const env = options.env ?? process.env;
  const noProxy = preferredEnv(env, 'NO_PROXY')?.trim() ?? '';
  const mode: ProxyMode = providerMode ?? proxyMode(env);
  if (noProxy === '*') return [directResolution('直连（NO_PROXY=*）')];
  if (mode === 'direct')
    return [
      directResolution(
        providerMode === undefined ? '直连（CMSG_PROXY_MODE=direct）' : '直连（provider 强制）',
      ),
    ];

  const routes: ProxyResolution[] = [];
  if (mode !== 'system' && hasProxyEnvironment(env)) {
    const httpValue = preferredEnv(env, 'HTTP_PROXY');
    const httpsValue = preferredEnv(env, 'HTTPS_PROXY');
    const httpProxy = httpValue?.trim() ?? '';
    const httpsProxy = httpsValue?.trim() ?? httpProxy;
    routes.push({
      source: 'environment',
      httpProxy,
      httpsProxy,
      noProxy,
      description: '环境变量代理（遵循 NO_PROXY）',
    });
  }
  const system = systemResolution(endpoint, env, options);
  if (system) routes.push(system);

  if (mode === 'auto') routes.push(directResolution('直连（代理失败后的回退路径）'));
  if (mode === 'proxy' && !routes.length)
    throw new Error('未检测到可用代理，请配置 HTTP_PROXY / HTTPS_PROXY 或 Windows 系统代理。');
  if (mode === 'system' && !routes.length)
    routes.push(directResolution('直连（未检测到适用的静态系统代理）'));

  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.httpProxy}|${route.httpsProxy}|${route.noProxy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveProxy(endpoint: string, options: ResolveProxyOptions = {}): ProxyResolution {
  const routes = resolveProxyRoutes(endpoint, options);
  if (!routes.length) {
    return directResolution('直连（未检测到适用的代理）');
  }
  return routes[0]!;
}

export function createProxyAgent(resolution: ProxyResolution): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: resolution.httpProxy,
    httpsProxy: resolution.httpsProxy,
    noProxy: resolution.noProxy,
  });
}
