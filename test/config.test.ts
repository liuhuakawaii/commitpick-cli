import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function configModule() {
  const module = await import('../src/config.js').catch(() => null);
  assert.ok(module, 'Configuration module must be implemented');
  return module;
}

test('accepts host, base URL, custom prefix and full completion endpoint', async () => {
  const { normalizeEndpoint } = await configModule();
  assert.equal(
    normalizeEndpoint('https://relay.example/'),
    'https://relay.example/v1/chat/completions',
  );
  assert.equal(
    normalizeEndpoint('https://relay.example/v1/'),
    'https://relay.example/v1/chat/completions',
  );
  assert.equal(
    normalizeEndpoint('https://relay.example/api/v1'),
    'https://relay.example/api/v1/chat/completions',
  );
  assert.equal(
    normalizeEndpoint('http://localhost:1234/v1/chat/completions'),
    'http://localhost:1234/v1/chat/completions',
  );
  assert.throws(() => normalizeEndpoint('file:///tmp/test'), /http/);
  assert.throws(() => normalizeEndpoint('https://user:pass@relay.example'), /凭据/);
  assert.equal(
    normalizeEndpoint('https://relay.example/v1/responses'),
    'https://relay.example/v1/responses',
  );
});

test('Responses endpoint normalization preserves prefixes and switches known protocol suffixes', async () => {
  const { normalizeEndpoint } = await configModule();
  for (const [input, expected] of [
    ['https://relay.example', 'https://relay.example/v1/responses'],
    ['https://relay.example/custom/v1/', 'https://relay.example/custom/v1/responses'],
    [
      'https://relay.example/custom/v1/chat/completions',
      'https://relay.example/custom/v1/responses',
    ],
    ['https://relay.example/custom/v1/responses/', 'https://relay.example/custom/v1/responses'],
  ])
    assert.equal(normalizeEndpoint(input!, 'responses'), expected);
  assert.equal(
    normalizeEndpoint('https://relay.example/v1/responses', 'chat-completions'),
    'https://relay.example/v1/chat/completions',
  );
  assert.throws(() => normalizeEndpoint('https://relay.example/v1/messages', 'responses'), /协议/);
});

test('legacy configs stay on Chat Completions and protocol overrides do not modify saved config', async (t) => {
  const { loadConfig } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const original = JSON.stringify({
    endpoint: 'https://relay.example/custom/v1/chat/completions',
    model: 'm',
    apiKey: 'key',
    language: 'en',
    count: 3,
  });
  await writeFile(path, original);
  assert.equal((await loadConfig(path, {}))?.[0]?.protocol, 'chat-completions');
  const result = await loadConfig(path, { CMSG_PROTOCOL: 'responses' });
  assert.equal(result?.[0]?.protocol, 'responses');
  assert.equal(result?.[0]?.endpoint, 'https://relay.example/custom/v1/responses');
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(loadConfig(path, { CMSG_PROTOCOL: 'unknown' }), /协议/);
  await writeFile(
    path,
    JSON.stringify({ endpoint: 'https://relay.example/v1/responses', model: 'm' }),
  );
  assert.equal((await loadConfig(path, {}))?.[0]?.protocol, 'responses');
});

test('roundtrips config outside repository and environment overrides saved credentials', async (t) => {
  const { saveConfig, loadConfig } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'config.json');
  assert.equal(await loadConfig(path, {}), null);
  await saveConfig(
    {
      protocol: 'chat-completions',
      endpoint: 'https://relay.example/v1/chat/completions',
      apiKey: 'test-key',
      model: 'fast-model',
    },
    path,
  );
  const saved = await loadConfig(path, {});
  assert.equal(saved?.[0]?.apiKey, 'test-key');
  const overridden = await loadConfig(path, {
    CMSG_API_KEY: 'env-key',
    CMSG_MODEL: 'env-model',
    CMSG_BASE_URL: 'https://other.example/v1',
  });
  assert.equal(overridden?.[0]?.apiKey, 'env-key');
  assert.equal(overridden?.[0]?.model, 'env-model');
  assert.equal(overridden?.[0]?.endpoint, 'https://other.example/v1/chat/completions');
  assert.doesNotMatch(await readFile(path, 'utf8'), /env-key/);
});

test('full endpoints at the domain root keep their exact path', async () => {
  const { normalizeEndpoint } = await configModule();
  assert.equal(
    normalizeEndpoint('https://relay.example/chat/completions'),
    'https://relay.example/chat/completions',
  );
  assert.equal(
    normalizeEndpoint('https://relay.example/responses'),
    'https://relay.example/responses',
  );
  assert.equal(
    normalizeEndpoint('https://relay.example/chat/completions', 'responses'),
    'https://relay.example/responses',
  );
});

test('malformed config is reported rather than silently replaced', async (t) => {
  const { loadConfig } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{oops');
  await assert.rejects(loadConfig(path, {}), /配置/);
  await writeFile(path, JSON.stringify({ endpoint: 'https://example.com', model: '' }));
  await assert.rejects(loadConfig(path, {}), /语言|配置|数量/);
});

test('environment-only configuration works without a saved key', async () => {
  const { loadConfig } = await configModule();
  const result = await loadConfig(join(tmpdir(), 'nonexistent-commitpick-config.json'), {
    CMSG_BASE_URL: 'http://localhost:1234/v1',
    CMSG_MODEL: 'local-model',
  });
  assert.equal(result?.[0]?.apiKey, '');
});

test('saved AI connection and preferences have independent ownership', async (t) => {
  const { saveConfig, loadConfig, savePreferences, loadPreferences } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-separate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await saveConfig(
    { protocol: 'responses', endpoint: 'https://example.com/v1', apiKey: '', model: 'm' },
    path,
  );
  assert.deepEqual(await loadPreferences(path), { language: 'both', count: 4 });
  await savePreferences({ language: 'zh', count: 2 }, path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.language, undefined);
  assert.equal(saved.count, undefined);
  assert.equal((await loadConfig(path, {}))?.[0]?.model, 'm');
  assert.deepEqual(await loadPreferences(path), { language: 'zh', count: 2 });
});
