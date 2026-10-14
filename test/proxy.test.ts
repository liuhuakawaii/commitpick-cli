import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createProxyAgent, resolveProxy } from '../src/proxy.js';

test('explicit proxy environment variables take precedence over Windows system proxy', () => {
  const result = resolveProxy('https://api.example.test/v1/responses', {
    platform: 'win32',
    env: { https_proxy: 'http://lower.example:8080', HTTPS_PROXY: 'http://upper.example:8080' },
    readSystemProxy: () => ({ proxyServer: '127.0.0.1:7897', enabled: true }),
  });
  assert.equal(result.source, 'environment');
  assert.equal(result.httpsProxy, 'http://lower.example:8080');
  assert.equal(result.httpProxy, '');
});

test('Windows static proxy selects the HTTP and HTTPS settings independently', () => {
  const result = resolveProxy('https://api.example.test/v1/responses', {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({
      enabled: true,
      proxyServer: 'http=127.0.0.1:7897;https=127.0.0.1:7898',
      proxyOverride: '<local>;*.internal.test;api.example.test:8443',
    }),
  });
  assert.equal(result.source, 'windows-system');
  assert.equal(result.httpProxy, 'http://127.0.0.1:7897');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:7898');
  assert.notEqual(result.noProxy, '*');
});

test('system bypass rules honor wildcards, ports, protocols and short local names', () => {
  const options = {
    platform: 'win32' as const,
    env: {},
    readSystemProxy: () => ({
      enabled: true,
      proxyServer: '127.0.0.1:7897',
      proxyOverride: '<local>;*.internal.test;10.*;api.example.test:8443;http://plain.test',
    }),
  };
  for (const endpoint of [
    'http://printer',
    'https://api.internal.test',
    'https://10.1.2.3',
    'https://api.example.test:8443',
    'http://plain.test',
  ]) {
    assert.equal(resolveProxy(endpoint, options).noProxy, '*', endpoint);
  }
  for (const endpoint of [
    'https://internal.test',
    'https://api.example.test:443',
    'https://plain.test',
  ]) {
    assert.notEqual(resolveProxy(endpoint, options).noProxy, '*', endpoint);
  }
});

test('loopback addresses and NO_PROXY=* skip system discovery', () => {
  const options = {
    platform: 'win32' as const,
    env: {},
    readSystemProxy: () => {
      assert.fail('system lookup is unnecessary');
    },
  };
  for (const endpoint of ['http://localhost', 'http://127.0.0.2', 'http://[::1]:8080']) {
    assert.equal(resolveProxy(endpoint, options).source, 'direct');
  }
  assert.equal(
    resolveProxy('https://api.test', { ...options, env: { NO_PROXY: '*' } }).noProxy,
    '*',
  );
});

test('NO_PROXY alone supplements system discovery instead of disabling it', () => {
  const result = resolveProxy('https://api.test', {
    platform: 'win32',
    env: { NO_PROXY: '.internal.test' },
    readSystemProxy: () => ({ enabled: true, proxyServer: '127.0.0.1:7897' }),
  });
  assert.equal(result.source, 'windows-system');
  assert.equal(result.noProxy, '.internal.test');
});

test('a protocol-specific system proxy does not proxy unspecified protocols', () => {
  const result = resolveProxy('https://api.test', {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({ enabled: true, proxyServer: 'http=127.0.0.1:7897' }),
  });
  assert.equal(result.source, 'direct');
  assert.equal(result.noProxy, '*');
});

test('invalid enabled system proxy fails explicitly without exposing credentials', () => {
  assert.throws(
    () =>
      resolveProxy('https://api.test', {
        platform: 'win32',
        env: {},
        readSystemProxy: () => ({ enabled: true, proxyServer: 'http://user:secret@host:bad-port' }),
      }),
    (error: Error) => {
      assert.match(error.message, /系统代理.*无效/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test('PAC-only Windows configuration does not block direct requests or require extra setup', () => {
  const result = resolveProxy('https://api.example.test/v1/responses', {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({ enabled: false, autoConfigUrl: 'http://proxy.example/pac.js' }),
  });
  assert.equal(result.source, 'direct');
  assert.equal(result.httpProxy, '');
  assert.equal(result.httpsProxy, '');
  assert.match(result.description, /PAC|直连/);
});

test('discovered system proxy carries a real request without leaking credentials to CONNECT', async (t) => {
  let requests = 0;
  let tunnels = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer private-key');
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    assert.equal(req.url, 'relay.invalid:80');
    assert.equal(req.headers.authorization, undefined);
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
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    proxy.close();
  });
  const endpoint = 'http://relay.invalid/v1/responses';
  const resolution = resolveProxy(endpoint, {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({
      enabled: true,
      proxyServer: `127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    }),
  });
  const dispatcher = createProxyAgent(resolution);
  try {
    const request: RequestInit & { dispatcher: typeof dispatcher } = {
      dispatcher,
      headers: { Authorization: 'Bearer private-key' },
      signal: AbortSignal.timeout(2000),
    };
    const response = await fetch(endpoint, request);
    assert.equal(await response.text(), 'ok');
  } finally {
    await dispatcher.destroy();
  }
  assert.equal(requests, 1);
  assert.equal(tunnels, 1);
});

test('disabled settings and other platforms do not activate a stale proxy', () => {
  const disabled = resolveProxy('https://api.test', {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({ enabled: false, proxyServer: '127.0.0.1:7897' }),
  });
  assert.equal(disabled.source, 'direct');
  const linux = resolveProxy('https://api.test', {
    platform: 'linux',
    env: {},
    readSystemProxy: () => {
      assert.fail('must not query Windows settings');
    },
  });
  assert.equal(linux.source, 'direct');
});

test('system proxy diagnostics omit username and password', () => {
  const result = resolveProxy('https://api.test', {
    platform: 'win32',
    env: {},
    readSystemProxy: () => ({
      enabled: true,
      proxyServer: 'http://private-user:secret@proxy.test:8080',
    }),
  });
  assert.match(result.description, /proxy\.test:8080/);
  assert.doesNotMatch(result.description, /private-user|secret/);
});
