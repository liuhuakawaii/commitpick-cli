import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { generateMessages } from '../src/ai.js';
import { resolveProxyRoutes } from '../src/proxy.js';

test('schema output is explicitly opt-in and uses the selected protocol shape', async (t) => {
  for (const protocol of ['responses', 'chat-completions'] as const) {
    let body: any;
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, opts?: RequestInit) => {
      body = JSON.parse(opts!.body as string);
      const content = '{"messages":["feat: add greeting"]}';
      return new Response(
        JSON.stringify(
          protocol === 'responses'
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: content }],
                  },
                ],
              }
            : { choices: [{ message: { content } }] },
        ),
      );
    });
    await generateMessages(
      {
        protocol,
        endpoint: 'http://localhost',
        apiKey: '',
        model: 'm',
        language: 'en',
        count: 1,
        outputMode: 'json-schema',
      },
      'sample',
    );
    const schema = protocol === 'responses' ? body.text.format : body.response_format.json_schema;
    assert.equal(schema.strict, true);
    assert.equal(schema.schema.properties.messages.minItems, 1);
    assert.equal(schema.schema.properties.messages.maxItems, 1);
    mock.mock.restore();
  }
});

test('system discovery failures stay distinguishable from disabled and PAC settings', () => {
  assert.throws(
    () =>
      resolveProxyRoutes('https://example.test', 'proxy', {
        env: {},
        platform: 'win32',
        readSystemProxy: () => ({ readError: 'timeout' }),
      }),
    /读取 Windows 系统代理超时/,
  );
  assert.throws(
    () =>
      resolveProxyRoutes('https://example.test', 'proxy', {
        env: {},
        platform: 'win32',
        readSystemProxy: () => ({ enabled: false }),
      }),
    /未检测到可用代理/,
  );
  assert.match(
    resolveProxyRoutes('https://example.test', {
      env: {},
      platform: 'win32',
      readSystemProxy: () => ({ enabled: false, autoConfigUrl: 'secret-url' }),
    })[0]!.description,
    /PAC/,
  );
});

test('NO_PROXY resolves to one real direct route before budget allocation', () => {
  const routes = resolveProxyRoutes('https://api.internal.test', {
    env: { HTTPS_PROXY: 'http://proxy.test:8080', NO_PROXY: '.internal.test' },
    platform: 'linux',
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.source, 'direct');
});

test('a failed system lookup does not disable an explicit environment proxy', () => {
  const routes = resolveProxyRoutes('https://api.test', 'proxy', {
    env: { HTTPS_PROXY: 'http://proxy.test:8080' },
    platform: 'win32',
    readSystemProxy: () => ({ readError: 'timeout' }),
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.source, 'environment');
  assert.match(routes[0]!.description, /系统代理.*失败/);
  assert.throws(
    () =>
      resolveProxyRoutes('http://api.test', 'proxy', {
        env: { HTTPS_PROXY: 'http://proxy.test:8080' },
        platform: 'linux',
      }),
    /未检测到可用代理/,
  );
});

test('HTTP success containing non-JSON remains a response failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('private upstream page'));
  await assert.rejects(
    generateMessages(
      {
        protocol: 'responses',
        endpoint: 'http://localhost',
        apiKey: '',
        model: 'm',
        language: 'en',
        count: 1,
      },
      'sample',
    ),
    (e: Error & { diagnostic?: { stage: string; httpStatus?: number } }) => {
      assert.equal(e.diagnostic?.stage, 'response');
      assert.equal(e.diagnostic?.httpStatus, 200);
      assert.doesNotMatch(e.message, /private upstream/);
      return true;
    },
  );
});

test('stalled CONNECT tunnel times out before POST and falls back within total budget', async (t) => {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = names.map((n) => [n, process.env[n]] as const);
  names.forEach((n) => delete process.env[n]);
  t.after(() =>
    saved.forEach(([n, v]) => {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }),
  );
  let posts = 0;
  const server = createServer((_req, res) => {
    posts++;
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"messages":["feat: add greeting"]}' } }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const sockets = new Set<import('node:stream').Duplex>();
  const proxy = createServer();
  proxy.on('connect', (_req, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    sockets.forEach((s) => s.destroy());
    proxy.close();
    server.closeAllConnections();
    server.close();
  });
  process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const routes: string[] = [];
  const messages = await generateMessages(
    {
      protocol: 'chat-completions',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: '',
      model: 'm',
      language: 'en',
      count: 1,
      proxyMode: 'auto',
      connectTimeoutMs: 150,
    },
    'sample',
    { timeoutMs: 2000, onRoute: (r) => routes.push(r) },
  );
  assert.deepEqual(messages, ['feat: add greeting']);
  assert.equal(posts, 1);
  assert.match(routes.join('\n'), /建立连接超时/);
  assert.match(routes.at(-1)!, /直连/);
});

test('single language prompts exclude translation rules and reject wrong language', async (t) => {
  let prompt = '';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    prompt = JSON.parse(body).messages[0].content;
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"messages":["feat: 添加文件"]}' } }] }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    generateMessages(
      {
        protocol: 'chat-completions',
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: '',
        model: 'm',
        language: 'en',
        count: 1,
      },
      'sample',
    ),
    /语言/,
  );
  assert.doesNotMatch(prompt, /Simplified Chinese|8–18|添加/);
  assert.match(prompt, /exactly 1/);
});

test('connected slow proxy request uses total budget and is never replayed directly', async (t) => {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = names.map((n) => [n, process.env[n]] as const);
  names.forEach((n) => delete process.env[n]);
  t.after(() =>
    saved.forEach(([n, v]) => {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }),
  );
  let calls = 0;
  let delay = 600;
  const server = createServer((_req, res) => {
    calls++;
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"messages":["feat: add greeting"]}' } }],
          }),
        ),
      delay,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const proxy = createServer();
  proxy.on('connect', (_req, socket, head) => {
    const upstream = connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    proxy.close();
  });
  process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const config = {
    protocol: 'chat-completions' as const,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    proxyMode: 'auto' as const,
    apiKey: '',
    model: 'm',
    language: 'en' as const,
    count: 1,
    connectTimeoutMs: 200,
  };
  assert.deepEqual(await generateMessages(config, 'sample', { timeoutMs: 1000 }), [
    'feat: add greeting',
  ]);
  assert.equal(calls, 1);
  delay = 1000;
  await assert.rejects(generateMessages(config, 'sample', { timeoutMs: 400 }), /超时/);
  assert.equal(calls, 2, 'response timeout must not replay the POST on a second route');
});

test('candidate failure reports transport success and actual count without echoing content', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"messages":["feat: secret-one","feat: secret-two"]}' } },
          ],
        }),
      ),
  );
  await assert.rejects(
    generateMessages(
      {
        protocol: 'chat-completions',
        endpoint: 'http://localhost',
        proxyMode: 'direct',
        apiKey: 'secret-key',
        model: 'm',
        language: 'en',
        count: 1,
      },
      'sample',
    ),
    (
      e: Error & {
        diagnostic?: {
          stage: string;
          httpStatus?: number;
          expectedCount?: number;
          actualCount?: number;
        };
      },
    ) => {
      assert.equal(e.diagnostic?.stage, 'candidate');
      assert.equal(e.diagnostic?.httpStatus, 200);
      assert.equal(e.diagnostic?.actualCount, 2);
      assert.equal(e.diagnostic?.expectedCount, 1);
      assert.doesNotMatch(e.message, /secret/);
      return true;
    },
  );
});
