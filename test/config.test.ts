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
  assert.throws(() => normalizeEndpoint('https://relay.example/v1/responses'), /Chat Completions/);
});

test('roundtrips config outside repository and environment overrides saved credentials', async (t) => {
  const { saveConfig, loadConfig } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'config.json');
  assert.equal(await loadConfig(path, {}), null);
  await saveConfig(
    {
      endpoint: 'https://relay.example/v1/chat/completions',
      apiKey: 'test-key',
      model: 'fast-model',
      language: 'zh',
      count: 3,
    },
    path,
  );
  const saved = await loadConfig(path, {});
  assert.equal(saved?.apiKey, 'test-key');
  assert.equal(saved?.language, 'zh');
  assert.equal(saved?.count, 3);
  const overridden = await loadConfig(path, {
    CMSG_API_KEY: 'env-key',
    CMSG_MODEL: 'env-model',
    CMSG_BASE_URL: 'https://other.example/v1',
  });
  assert.equal(overridden?.apiKey, 'env-key');
  assert.equal(overridden?.model, 'env-model');
  assert.equal(overridden?.endpoint, 'https://other.example/v1/chat/completions');
  assert.doesNotMatch(await readFile(path, 'utf8'), /env-key/);
});

test('malformed config is reported rather than silently replaced', async (t) => {
  const { loadConfig } = await configModule();
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{oops');
  await assert.rejects(loadConfig(path, {}), /配置/);
  await writeFile(
    path,
    JSON.stringify({ endpoint: 'https://example.com', model: 'x', language: 'xx', count: 0 }),
  );
  await assert.rejects(loadConfig(path, {}), /语言|配置|数量/);
});

test('environment-only configuration works without a saved key', async () => {
  const { loadConfig } = await configModule();
  const result = await loadConfig(join(tmpdir(), 'nonexistent-commitpick-config.json'), {
    CMSG_BASE_URL: 'http://localhost:1234/v1',
    CMSG_MODEL: 'local-model',
  });
  assert.equal(result?.apiKey, '');
  assert.equal(result?.count, 3);
});
