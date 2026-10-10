import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

async function aiModule() {
  const module = await import('../src/ai.js').catch(() => null);
  assert.ok(module, 'AI generation module must be implemented');
  return module;
}

const messages = [
  'fix(auth): prevent duplicate refresh requests',
  'fix(auth): reuse the pending refresh promise',
  'fix(auth): serialize token refresh calls',
];

test('one request returns three candidates and forwards custom model, key and Chinese instruction', async (t) => {
  const { generateMessages } = await aiModule();
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/custom/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.model, 'relay-fast-model');
    assert.match(request.messages[0].content, /Chinese/);
    assert.match(request.messages[0].content, /3/);
    assert.match(request.messages[1].content, /actual-diff/);
    assert.equal(request.stream, false);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                messages: [
                  'fix(auth): 避免重复刷新令牌',
                  'fix(auth): 复用进行中的刷新请求',
                  'fix(auth): 串行处理令牌刷新',
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const result = await generateMessages(
    {
      endpoint: `http://127.0.0.1:${port}/custom/v1/chat/completions`,
      apiKey: 'test-key',
      model: 'relay-fast-model',
      language: 'zh',
      count: 3,
    },
    'actual-diff',
  );
  assert.equal(result.length, 3);
  assert.match(result[0]!, /避免重复/);
  assert.equal(calls, 1);
});

test('parses JSON fences; rejects malformed, duplicate, multiline and non-conventional candidates', async () => {
  const { parseMessages } = await aiModule();
  assert.deepEqual(
    parseMessages('```json\n' + JSON.stringify({ messages }) + '\n```', 3),
    messages,
  );
  for (const invalid of [
    'random output',
    JSON.stringify({ messages: ['fix: a'] }),
    JSON.stringify({ messages: ['fix: a', 'fix: a', 'fix: b'] }),
    JSON.stringify({ messages: ['fix：wrong colon', 'fix: b', 'fix: c'] }),
    JSON.stringify({ messages: ['fix: a\nbody', 'fix: b', 'fix: c'] }),
  ])
    assert.throws(() => parseMessages(invalid, 3), /候选|格式|JSON/);
});

test('HTTP errors never echo provider response or credentials', async (t) => {
  const { generateMessages } = await aiModule();
  const server = createServer((_req, res) => {
    res.writeHead(401);
    res.end('secret-provider-key');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await assert.rejects(
    generateMessages(
      {
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
        apiKey: 'secret-provider-key',
        model: 'm',
        count: 3,
        language: 'en',
      },
      'diff',
    ),
    (error: Error) => {
      assert.match(error.message, /401/);
      assert.doesNotMatch(error.message, /secret-provider-key/);
      return true;
    },
  );
});

test('slow endpoint times out without an automatic second request', async (t) => {
  const { generateMessages } = await aiModule();
  let calls = 0;
  const server = createServer(() => {
    calls++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    generateMessages(
      {
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
        apiKey: '',
        model: 'm',
        count: 3,
        language: 'en',
      },
      'diff',
      { timeoutMs: 150 },
    ),
    /超时/,
  );
  assert.equal(calls, 1);
});
