import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import type { Config } from '../src/config.js';

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

test('Responses sends one stateless request and extracts assistant text after reasoning items', async (t) => {
  const { generateMessages } = await aiModule();
  const requests: { url?: string; authorization?: string; body: Record<string, any> }[] = [];
  const text = JSON.stringify({ messages });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(body),
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: text.slice(0, 20) },
              { type: 'output_text', text: text.slice(20) },
            ],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const result = await generateMessages(
    {
      protocol: 'responses',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom/v1/responses`,
      apiKey: 'test-key',
      model: 'relay-model',
      language: 'zh',
      count: 3,
    },
    'actual-diff',
    { hint: 'intent' },
  );
  assert.deepEqual(result, messages);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, '/custom/v1/responses');
  assert.equal(request.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'relay-model');
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, false);
  assert.match(request.body.instructions, /Simplified Chinese/);
  assert.deepEqual(JSON.parse(request.body.input[0].content), {
    hint: 'intent',
    diff: 'actual-diff',
  });
  assert.equal(request.body.messages, undefined);
});

test('Responses rejects unfinished, failed, refused and malformed output without exposing response data', async (t) => {
  const { generateMessages } = await aiModule();
  const validOutput = [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ messages }) }],
    },
  ];
  let payload: unknown;
  let status = 200;
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const config: Config = {
    protocol: 'responses',
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
    apiKey: 'secret-key',
    model: 'm',
    language: 'en',
    count: 3,
  };
  for (const responseStatus of ['incomplete', 'failed', 'queued', 'in_progress', 'cancelled']) {
    payload = { status: responseStatus, output: validOutput, error: { message: 'secret-key' } };
    await assert.rejects(generateMessages(config, 'diff'), (error: Error) => {
      assert.match(error.message, /Responses.*未完成|Responses.*失败/);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    });
  }
  payload = {
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'secret-key' }] },
    ],
  };
  await assert.rejects(generateMessages(config, 'diff'), /拒绝/);
  for (const output of [
    undefined,
    {},
    [null],
    [{ type: 'reasoning' }],
    [{ type: 'message', role: 'assistant', content: {} }],
  ]) {
    payload = { status: 'completed', output };
    await assert.rejects(generateMessages(config, 'diff'), /Responses.*文本|Responses.*格式/);
  }
  payload = {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ messages: ['fix: same', 'fix: same', 'fix: same'] }),
          },
        ],
      },
    ],
  };
  await assert.rejects(generateMessages(config, 'diff'), /重复/);
  status = 403;
  payload = { error: { message: 'secret-key' } };
  await assert.rejects(generateMessages(config, 'diff'), (error: Error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });
  assert.equal(calls, 13);
});

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
      protocol: 'chat-completions',
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
        protocol: 'chat-completions',
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
        protocol: 'chat-completions',
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

test('AI requests honor environment proxies and NO_PROXY without forwarding the API key to CONNECT', async (t) => {
  const { generateMessages } = await aiModule();
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer private-key');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url!);
    assert.equal(req.headers.authorization, undefined);
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    proxy.close();
  });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const config: Config = {
    protocol: 'chat-completions',
    endpoint: 'http://relay.invalid/v1/chat/completions',
    apiKey: 'private-key',
    model: 'm',
    language: 'en',
    count: 3,
  };
  process.env.HTTP_PROXY = proxyUrl;
  assert.deepEqual(await generateMessages(config, 'diff'), messages);
  assert.deepEqual(tunnels, ['relay.invalid:80']);
  process.env.NO_PROXY = '127.0.0.1';
  assert.deepEqual(
    await generateMessages(
      { ...config, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
      'diff',
    ),
    messages,
  );
  assert.equal(tunnels.length, 1);
  assert.equal(requests, 2);
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  process.env.https_proxy = proxyUrl;
  await assert.rejects(
    generateMessages({ ...config, endpoint: 'https://relay.invalid/v1/responses' }, 'diff', {
      timeoutMs: 1000,
    }),
  );
  assert.equal(tunnels.at(-1), 'relay.invalid:443');
  assert.equal(requests, 2, 'TLS failure must not send a model request or fall back to HTTP');
});

test('network diagnostics classify nested causes without echoing credentials or arbitrary error text', async (t) => {
  const { generateMessages } = await aiModule();
  const config: Config = {
    protocol: 'responses',
    endpoint: 'https://relay.invalid/v1/responses',
    apiKey: 'private-key',
    model: 'm',
    count: 3,
    language: 'en',
  };
  for (const [code, guidance] of [
    ['ETIMEDOUT', /代理|超时/],
    ['ENETUNREACH', /网络|代理/],
    ['ENOTFOUND', /DNS/],
    ['ECONNREFUSED', /拒绝/],
    ['CERT_HAS_EXPIRED', /证书/],
  ] as const) {
    const cause = Object.assign(new Error('private-key https://user:password@proxy.invalid'), {
      code,
    });
    const mocked = t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('private-key', { cause: new AggregateError([cause], 'private-key') });
    });
    await assert.rejects(generateMessages(config, 'diff'), (error: Error) => {
      assert.match(error.message, new RegExp(code));
      assert.match(error.message, guidance);
      assert.doesNotMatch(error.message, /private-key|password/);
      return true;
    });
    mocked.mock.restore();
  }
});
