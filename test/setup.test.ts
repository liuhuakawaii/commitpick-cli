import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig } from '../src/config.js';

test('setup asks for address, masked key, model and language; preserves saved key on rerun', async (t) => {
  const module = await import('../src/setup.js').catch(() => null);
  assert.ok(module, 'Interactive setup must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const inputs = ['https://relay.example/v1', 'fast-model'];
  let passwordCalls = 0;
  await module.setupConfig(path, {
    input: async () => inputs.shift()!,
    password: async () => {
      passwordCalls++;
      return 'test-key';
    },
    select: async ({ message }) => (message.includes('协议') ? 'chat-completions' : 'zh'),
  });
  const saved = await loadConfig(path, {});
  assert.equal(saved?.endpoint, 'https://relay.example/v1/chat/completions');
  assert.equal(saved?.apiKey, 'test-key');
  assert.equal(saved?.model, 'fast-model');
  assert.equal(saved?.language, 'zh');
  assert.equal(saved?.count, 3);
  assert.equal(passwordCalls, 1);
  await saveConfig({ ...saved!, count: 5 }, path);
  await module.setupConfig(path, {
    input: async ({ default: value }) => value!,
    password: async () => '',
    select: async ({ message }) => (message.includes('协议') ? 'chat-completions' : 'en'),
  });
  assert.equal((await loadConfig(path, {}))?.apiKey, 'test-key');
  assert.equal((await loadConfig(path, {}))?.count, 5);
});

test('setup switches a saved Chat Completions endpoint to Responses without persisting environment overrides', async (t) => {
  const { setupConfig } = await import('../src/setup.js');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await saveConfig(
    {
      protocol: 'chat-completions',
      endpoint: 'https://relay.example/custom/v1/chat/completions',
      apiKey: 'saved-key',
      model: 'saved-model',
      language: 'zh',
      count: 5,
    },
    path,
  );
  const original = process.env.CMSG_PROTOCOL;
  process.env.CMSG_PROTOCOL = 'chat-completions';
  t.after(() => {
    if (original === undefined) delete process.env.CMSG_PROTOCOL;
    else process.env.CMSG_PROTOCOL = original;
  });
  await setupConfig(path, {
    input: async ({ default: value }) => value!,
    password: async () => '',
    select: async ({ message }) => (message.includes('协议') ? 'responses' : 'zh'),
  });
  assert.deepEqual(await loadConfig(path, {}), {
    protocol: 'responses',
    endpoint: 'https://relay.example/custom/v1/responses',
    apiKey: 'saved-key',
    model: 'saved-model',
    language: 'zh',
    count: 5,
  });
});
