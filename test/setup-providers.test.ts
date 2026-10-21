import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadPreferences, savePreferences } from '../src/config.js';
import { setupConfig } from '../src/setup.js';

type UI = NonNullable<Parameters<typeof setupConfig>[1]>;
function prompts(answers: Record<string, string> = {}, key = 'test-key'): UI {
  const prefixes: Record<string, string> = {
    操作: '配置操作',
    来源: 'AI 来源',
    名称: '来源名称',
    协议: 'AI 接口协议',
    地址: 'AI 地址',
    模型名: '模型名',
    超时: '请求超时',
    编辑: '选择要编辑',
    移除: '选择要移除',
  };
  const answer = (message: string, fallback?: string) =>
    Object.entries(answers).find(([part]) => message.startsWith(prefixes[part] ?? part))?.[1] ??
    fallback ??
    '';
  return {
    input: async ({ message, default: value, validate }) => {
      const result = answer(message, value);
      const valid = validate?.(result);
      if (valid !== undefined && valid !== true) throw new Error(String(valid));
      return result;
    },
    password: async ({ validate }) => {
      const valid = validate?.(key);
      if (valid !== undefined && valid !== true) throw new Error(String(valid));
      return key;
    },
    select: async ({ message, default: value }) => answer(message, value),
  };
}

test('adding, reordering and editing providers preserves siblings, preferences and saved keys', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await setupConfig(path, prompts({ 名称: 'free', 超时: '5' }, 'free-key'));
  await savePreferences({ language: 'zh', count: 5 }, path);
  await setupConfig(
    path,
    prompts(
      {
        操作: 'add',
        来源: 'custom',
        名称: 'paid',
        协议: 'responses',
        地址: 'https://relay.example/v1',
        模型名: 'paid-model',
        超时: '10',
      },
      'paid-key',
    ),
  );
  assert.deepEqual(
    (await loadConfig(path, {}))?.map((p) => [p.name, p.apiKey, p.timeoutMs]),
    [
      ['free', 'free-key', 5000],
      ['paid', 'paid-key', 10000],
    ],
  );
  const order = prompts({ 操作: 'order' });
  order.select = async ({ message }) => (message.includes('操作') ? 'order' : 'paid');
  await setupConfig(path, order);
  assert.deepEqual(
    (await loadConfig(path, {}))?.map((p) => p.name),
    ['paid', 'free'],
  );
  await setupConfig(path, prompts({ 操作: 'edit', 编辑: 'paid', 模型名: 'faster-model' }, ''));
  const saved = (await loadConfig(path, {}))!;
  assert.equal(saved[0]?.model, 'faster-model');
  assert.equal(saved[0]?.apiKey, 'paid-key');
  assert.equal(saved[1]?.apiKey, 'free-key');
  assert.deepEqual(await loadPreferences(path), { language: 'zh', count: 5 });
  const before = await readFile(path, 'utf8');
  await assert.rejects(setupConfig(path, prompts({ 操作: 'add', 名称: 'free' })), /名称|重复/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('removing the last provider backs up the list and returns to unconfigured mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-remove-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await setupConfig(path, prompts({ 名称: 'free' }));
  const before = await readFile(path, 'utf8');
  await setupConfig(path, prompts({ 操作: 'remove', 移除: 'free' }));
  assert.equal(await loadConfig(path, {}), null);
  const backup = (await readdir(dir)).find((name) => name.endsWith('.bak'))!;
  assert.equal(await readFile(join(dir, backup), 'utf8'), before);
});

test('setup accepts millisecond precision and rejects invalid timeouts without replacing saved config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await setupConfig(path, prompts({ 超时: '1.001' }));
  assert.equal((await loadConfig(path, {}))?.[0]?.timeoutMs, 1001);
  const before = await readFile(path, 'utf8');
  for (const timeout of ['0', '-1', '121', '1.0001', 'no']) {
    await assert.rejects(setupConfig(path, prompts({ 超时: timeout })), /超时/);
    assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('editing a free source into a different endpoint does not carry its credentials across', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await setupConfig(path, prompts({ 名称: 'free' }, 'free-key'));
  await setupConfig(
    path,
    prompts({ 来源: 'custom', 地址: 'http://localhost:1234/v1', 模型名: 'local-model' }, ''),
  );
  assert.equal((await loadConfig(path, {}))?.[0]?.apiKey, '');
});
