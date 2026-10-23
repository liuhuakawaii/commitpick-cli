import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, saveConfig } from '../src/config.js';

test('ordered providers roundtrip, legacy reads are non-mutating, and env overrides isolate one provider', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-providers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const legacy = JSON.stringify({
    endpoint: 'https://relay.example/v1',
    model: 'm',
    apiKey: 'old-key',
  });
  await writeFile(path, legacy);
  const original = await loadConfig(path, {});
  assert.ok(Array.isArray(original), 'config must normalize to an ordered provider list');
  assert.equal(original[0]?.name, 'default');
  assert.equal(await readFile(path, 'utf8'), legacy);
  const providers = [
    {
      name: 'primary',
      protocol: 'chat-completions' as const,
      endpoint: 'https://primary.example/v1/chat/completions',
      model: 'primary-model',
      apiKey: 'primary-key',
      timeoutMs: 5000,
    },
    {
      name: 'backup',
      protocol: 'responses' as const,
      endpoint: 'https://backup.example/v1/responses',
      model: 'backup-model',
      apiKey: 'backup-key',
      timeoutMs: 30000,
    },
  ];
  await saveConfig(providers, path);
  assert.deepEqual(await loadConfig(path, {}), providers);
  assert.deepEqual(
    (await loadConfig(path, { CMSG_API_KEY: 'temporary-key' }))?.map((p) => [p.name, p.apiKey]),
    [['primary', 'temporary-key']],
  );
  assert.deepEqual(await loadConfig(path, {}), providers);
  assert.doesNotMatch(await readFile(path, 'utf8'), /temporary-key/);
  await assert.rejects(saveConfig([providers[0]!, providers[0]!], path), /名称|重复/);
  for (const timeoutMs of [0, -1, 1.5, 120001]) {
    await assert.rejects(saveConfig([{ ...providers[0]!, timeoutMs }], path), /超时/);
  }
  assert.deepEqual(
    await loadConfig(path, {}),
    providers,
    'invalid writes leave saved config intact',
  );
  await saveConfig([], path);
  assert.equal(await loadConfig(path, {}), null);
  assert.equal(await loadConfig(path, { CMSG_API_KEY: 'key-without-source' }), null);
});

test('fallback follows priority across failures, reuses the snapshot, stops on success, and keeps usage isolated', async (t) => {
  const ai = await import('../src/ai.js');
  assert.equal(typeof ai.generateWithFallback, 'function', 'fallback generation must exist');
  const calls: { model: string; input: unknown; key: string | undefined }[] = [];
  let firstStatus = 429;
  let invalidSecond = false;
  const messages = ['fix: reuse requests'];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    calls.push({
      model: body.model,
      input: body.input ?? body.messages?.[1]?.content,
      key: req.headers.authorization,
    });
    if (body.model === 'primary') {
      if (firstStatus === 0) return;
      if (firstStatus === -1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(firstStatus);
      res.end('private-provider-error');
    } else {
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text:
                    invalidSecond && body.model === 'backup'
                      ? 'bad-json'
                      : JSON.stringify({ messages }),
                },
              ],
            },
          ],
          ...(body.model === 'backup' ? { usage: { input_tokens: 12, output_tokens: 8 } } : {}),
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const providers = [
    {
      name: 'primary',
      protocol: 'chat-completions' as const,
      endpoint,
      model: 'primary',
      apiKey: 'primary-secret',
      timeoutMs: 500,
    },
    {
      name: 'backup',
      protocol: 'responses' as const,
      endpoint,
      model: 'backup',
      apiKey: 'backup-secret',
      timeoutMs: 1000,
    },
    {
      name: 'unused',
      protocol: 'responses' as const,
      endpoint,
      model: 'unused',
      apiKey: '',
      timeoutMs: 1000,
    },
  ];
  const failures: string[] = [];
  const result = await ai.generateWithFallback(
    providers,
    { language: 'en', count: 1 },
    'snapshot',
    {
      hint: 'reuse',
      onFailure: (_provider, reason) => failures.push(reason),
    },
  );
  assert.deepEqual(
    calls.map((c) => c.model),
    ['primary', 'backup'],
  );
  assert.deepEqual(JSON.parse(calls[0]!.input as string), { hint: 'reuse', diff: 'snapshot' });
  firstStatus = -1;
  calls.length = 0;
  await ai.generateWithFallback(providers, { language: 'en', count: 1 }, 'snapshot');
  assert.deepEqual(
    calls.map((c) => c.model),
    ['primary', 'backup'],
  );
  assert.equal(calls[0]?.key, 'Bearer primary-secret');
  assert.equal(calls[1]?.key, 'Bearer backup-secret');
  assert.equal(calls[0]?.input, (calls[1]?.input as { content: string }[])[0]?.content);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.provider.name, 'backup');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.match(failures[0]!, /429/);
  calls.length = 0;
  firstStatus = 0;
  await ai.generateWithFallback(providers, { language: 'en', count: 1 }, 'snapshot');
  assert.deepEqual(
    calls.map((c) => c.model),
    ['primary', 'backup'],
  );
  firstStatus = 401;
  invalidSecond = true;
  calls.length = 0;
  await assert.rejects(
    ai.generateWithFallback(providers.slice(0, 2), { language: 'en', count: 1 }, 'snapshot'),
    (error: Error) => {
      assert.match(error.message, /全部|所有/);
      assert.match(error.message, /primary/);
      assert.match(error.message, /backup/);
      assert.doesNotMatch(error.message, /secret|private-provider-error/);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(
    calls.map((c) => c.model),
    ['primary', 'backup'],
  );
  calls.length = 0;
  const recovered = await ai.generateWithFallback(
    providers,
    { language: 'en', count: 1 },
    'snapshot',
  );
  assert.equal(recovered.provider.name, 'unused');
  assert.equal(
    recovered.usage,
    undefined,
    'usage from an invalid backup response must not leak into the winner',
  );
  assert.deepEqual(
    calls.map((c) => c.model),
    ['primary', 'backup', 'unused'],
  );
});
