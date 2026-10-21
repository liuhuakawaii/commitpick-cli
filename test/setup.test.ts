import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, loadPreferences, saveConfig, savePreferences } from '../src/config.js';

test('free cloud setup fixes endpoint and model and persists an independently named source', async (t) => {
  const { setupConfig } = await import('../src/setup.js');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-free-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const selections: string[] = [];
  const config = await setupConfig(path, {
    input: async ({ message, default: value }) => {
      assert.doesNotMatch(message, /AI 地址|模型名/);
      return value!;
    },
    password: async ({ message, mask, validate }) => {
      assert.match(message, /openrouter.ai\/settings\/keys/);
      assert.equal(mask, '*');
      assert.notEqual(validate?.(''), true);
      assert.notEqual(validate?.('-'), true);
      assert.equal(validate?.('free-key'), true);
      return ' free-key ';
    },
    select: async ({ message, default: value, choices }) => {
      selections.push(message);
      if (message.includes('来源')) {
        assert.equal(value, 'openrouter-free');
        assert.ok(choices.some((choice) => choice.value === 'custom'));
        return 'openrouter-free';
      }
      assert.match(message, /语言/);
      return 'both';
    },
  });
  assert.equal(selections.length, 2);
  assert.deepEqual(await loadConfig(path, {}), [
    {
      name: 'provider-1',
      timeoutMs: 30000,
      protocol: 'chat-completions',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      apiKey: 'free-key',
    },
  ]);
  assert.equal(config.length, 1);
  assert.deepEqual(await loadPreferences(path), { language: 'both', count: 4 });
  await setupConfig(path, {
    input: async ({ message, default: value }) => {
      assert.doesNotMatch(message, /AI 地址|模型名/);
      return value!;
    },
    password: async ({ message }) => {
      assert.match(message, /保留/);
      return '';
    },
    select: async ({ default: value }) => value,
  });
  assert.equal((await loadConfig(path, {}))?.[0]?.apiKey, 'free-key');

  // Exercise the persisted preset through the real request pipeline against a local fixture.
  const { generateMessages } = await import('../src/ai.js');
  const requests: Record<string, unknown>[] = [];
  let status = 200;
  const candidates = [
    'docs: add guide',
    'docs: introduce guide',
    'docs: 添加指南',
    'docs: 新增使用指南',
  ];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.statusCode = status;
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ messages: candidates }) } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const saved = {
    ...(await loadConfig(path, {}))![0]!,
    ...(await loadPreferences(path)),
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/completions`,
  };
  assert.deepEqual(await generateMessages(saved, 'diff'), candidates);
  for (status of [429, 503]) {
    await assert.rejects(generateMessages(saved, 'diff'), new RegExp(`HTTP ${status}`));
  }
  assert.equal(requests.length, 3, 'each attempt sends one request, including failures');
  for (const body of requests) {
    assert.equal(body.model, 'openrouter/free');
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream']);
  }
});

test('switching to free cloud rejects missing keys without reusing a relay key or changing files', async (t) => {
  const { setupConfig } = await import('../src/setup.js');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-free-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await saveConfig(
    {
      protocol: 'responses',
      endpoint: 'https://relay.example/v1/responses',
      model: 'paid-model',
      apiKey: 'relay-key',
    },
    path,
  );
  await savePreferences({ language: 'zh', count: 5 }, path);
  const original = await readFile(path, 'utf8');
  for (const key of ['', ' ', '-']) {
    await assert.rejects(
      setupConfig(path, {
        input: async ({ default: value }) => value!,
        password: async ({ message }) => {
          assert.doesNotMatch(message, /保留/);
          return key;
        },
        select: async ({ message, default: value }) => {
          if (message === 'AI 来源') {
            assert.equal(value, 'custom');
            return 'openrouter-free';
          }
          return value;
        },
      }),
      /OpenRouter.*Key/,
    );
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await loadPreferences(path), { language: 'zh', count: 5 });
  }
});

test('explicit reset backs up malformed configuration before replacing it', async (t) => {
  const { setupConfig } = await import('../src/setup.js');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-reset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{broken');
  await setupConfig(
    path,
    {
      input: async ({ message, default: value }) =>
        message.includes('地址')
          ? 'http://localhost:1234/v1'
          : message.startsWith('模型名')
            ? 'local-model'
            : value!,
      password: async () => '',
      select: async ({ message }) =>
        message.includes('来源') ? 'custom' : message.includes('协议') ? 'responses' : 'both',
    },
    { reset: true },
  );
  const backup = (await readdir(dir)).find((name) => name.endsWith('.bak'));
  assert.ok(backup, 'reset must leave a recoverable backup');
  assert.equal(await readFile(join(dir, backup), 'utf8'), '{broken');
  assert.equal((await loadConfig(path, {}))?.[0]?.model, 'local-model');
});

test('setup asks for address, masked key, model and language; preserves saved key on rerun', async (t) => {
  const module = await import('../src/setup.js').catch(() => null);
  assert.ok(module, 'Interactive setup must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const inputs = ['https://relay.example/v1', 'fast-model'];
  let passwordCalls = 0;
  await module.setupConfig(path, {
    input: async ({ message, default: value }) =>
      /AI 地址|模型名/.test(message) ? inputs.shift()! : value!,
    password: async () => {
      passwordCalls++;
      return 'test-key';
    },
    select: async ({ message }) =>
      message.includes('来源') ? 'custom' : message.includes('协议') ? 'chat-completions' : 'zh',
  });
  const saved = await loadConfig(path, {});
  assert.equal(saved?.[0]?.endpoint, 'https://relay.example/v1/chat/completions');
  assert.equal(saved?.[0]?.apiKey, 'test-key');
  assert.equal(saved?.[0]?.model, 'fast-model');
  assert.deepEqual(await loadPreferences(path), { language: 'zh', count: 4 });
  assert.equal(passwordCalls, 1);
  await savePreferences({ language: 'zh', count: 5 }, path);
  await module.setupConfig(path, {
    input: async ({ default: value }) => value!,
    password: async () => '',
    select: async ({ message }) =>
      message.startsWith('配置操作')
        ? 'edit'
        : message.includes('来源')
          ? 'custom'
          : message.includes('协议')
            ? 'chat-completions'
            : 'en',
  });
  assert.equal((await loadConfig(path, {}))?.[0]?.apiKey, 'test-key');
  assert.equal((await loadPreferences(path)).count, 5);
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
    },
    path,
  );
  await savePreferences({ language: 'zh', count: 5 }, path);
  const original = process.env.CMSG_PROTOCOL;
  process.env.CMSG_PROTOCOL = 'chat-completions';
  t.after(() => {
    if (original === undefined) delete process.env.CMSG_PROTOCOL;
    else process.env.CMSG_PROTOCOL = original;
  });
  await setupConfig(path, {
    input: async ({ default: value }) => value!,
    password: async () => '',
    select: async ({ message }) =>
      message.startsWith('配置操作')
        ? 'edit'
        : message.includes('来源')
          ? 'custom'
          : message.includes('协议')
            ? 'responses'
            : 'zh',
  });
  assert.deepEqual(await loadConfig(path, {}), [
    {
      name: 'default',
      timeoutMs: 30000,
      protocol: 'responses',
      endpoint: 'https://relay.example/custom/v1/responses',
      apiKey: 'saved-key',
      model: 'saved-model',
    },
  ]);
  assert.deepEqual(await loadPreferences(path), { language: 'zh', count: 5 });
});
