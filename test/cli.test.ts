import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const execute = promisify(execFile);
const cli = resolve('src/cli.ts');
const runner = resolve('node_modules/tsx/dist/cli.mjs');
async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const pending = execute(process.execPath, [runner, cli, ...args], {
    cwd,
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  pending.child.stdin?.end();
  return pending;
}

test('CLI generates English/Chinese candidates through a relay, JSON is clean and Git is unchanged', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'commitpick-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(cwd, 'hello.ts'), 'export const hello = true;\n');
  let calls = 0;
  let lastDiff = '';
  let responseStatus = 200;
  const server = createServer(async (req, res) => {
    calls++;
    if (responseStatus !== 200) {
      res.writeHead(responseStatus);
      res.end('private upstream error');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const responses = req.url?.endsWith('/responses');
    lastDiff = JSON.parse(responses ? payload.input[0].content : payload.messages[1].content).diff;
    const chinese = (responses ? payload.instructions : payload.messages[0].content).includes(
      'Simplified Chinese',
    );
    const messages = chinese
      ? ['feat: 增加问候开关', 'feat: 提供问候配置', 'feat: 导出问候标志']
      : [
          'feat: add greeting flag',
          'feat: expose greeting configuration',
          'feat: export greeting toggle',
        ];
    res.setHeader('content-type', 'application/json');
    const content = JSON.stringify({ messages });
    res.end(
      JSON.stringify(
        responses
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const env = {
    ...process.env,
    CMSG_CONFIG: join(cwd, 'missing', 'config.json'),
    CMSG_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    CMSG_MODEL: 'test-model',
    CMSG_API_KEY: 'test-key',
    CMSG_PROTOCOL: 'chat-completions',
  };
  const before = git('status', '--porcelain');
  for (const args of [['--json'], ['zh', '--json'], ['--lang', 'zh', '--json']]) {
    const result = await run(args, cwd, env).catch((error: Error) => ({
      stdout: '',
      stderr: error.message,
    }));
    assert.ok(result.stdout.startsWith('{'), `CLI must return JSON: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.scope, 'worktree');
    assert.equal(data.messages.length, 3);
    if (args.includes('zh')) assert.match(data.messages[0], /增加/);
    else assert.match(data.messages[0], /greeting/);
    assert.equal(git('status', '--porcelain'), before);
  }
  const picked = await run(['--pick', '2'], cwd, env);
  assert.equal(picked.stdout.trim(), 'feat: expose greeting configuration');
  assert.equal(calls, 4);
  await assert.rejects(run(['--staged', '--worktree'], cwd, env));
  await assert.rejects(run(['--count', '0'], cwd, env));
  await assert.rejects(run(['--copy'], cwd, env), (error: Error & { stderr: string }) => {
    assert.match(error.stderr, /--pick/);
    return true;
  });
  assert.equal(calls, 4, 'invalid CLI options must not call the AI');
  const shown = await run(['config'], cwd, env);
  assert.doesNotMatch(shown.stdout, /test-key/);
  assert.match(shown.stdout, /test-model/);
  await writeFile(join(cwd, 'bundle.min.js'), 'minifiedBundle();'.repeat(40_000));
  const large = await run(['--json'], cwd, env);
  assert.equal(JSON.parse(large.stdout).messages.length, 3);
  assert.match(large.stderr, /已自动整理/);
  assert.match(lastDiff, /hello.ts/);
  assert.match(lastDiff, /bundle.min.js/);
  assert.doesNotMatch(lastDiff, /minifiedBundle/);
  assert.ok(Buffer.byteLength(lastDiff) < 160_000);
  assert.equal(calls, 5, 'large changes still need only one AI request');
  const status = git('status', '--porcelain');
  const responses = await run(['zh', '--json'], cwd, { ...env, CMSG_PROTOCOL: 'responses' });
  assert.match(JSON.parse(responses.stdout).messages[0], /增加/);
  assert.equal(calls, 6);
  assert.equal(git('status', '--porcelain'), status);
  responseStatus = 503;
  await assert.rejects(
    run(['--json'], cwd, env),
    (error: Error & { stdout: string; stderr: string }) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /503/);
      assert.doesNotMatch(error.stderr, /本地规则|private upstream error/);
      return true;
    },
  );
  assert.equal(calls, 7);
  const offline = await run(['--local', '--json'], cwd, env);
  assert.equal(JSON.parse(offline.stdout).source, 'local');
  assert.equal(calls, 7, 'explicit local mode must not contact the configured AI');
});

test('missing config generates local candidates without setup or network and preserves Git', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'commitpick-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(join(cwd, 'file.ts'), 'new-file');
  const env = {
    ...process.env,
    CMSG_CONFIG: join(cwd, 'missing.json'),
    CMSG_BASE_URL: '',
    CMSG_MODEL: '',
    CMSG_API_KEY: '',
    CMSG_PROTOCOL: '',
  };
  const before = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  const result = await run(['zh', '--json'], cwd, env);
  const data = JSON.parse(result.stdout);
  assert.equal(data.source, 'local');
  assert.equal(data.messages.length, 3);
  assert.match(data.messages[0], /file.ts/);
  assert.match(result.stderr, /本地规则/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), before);
  const explicit = await run(['--local', '--pick', '2', '-n', '5'], cwd, {
    ...env,
    CMSG_BASE_URL: 'invalid',
    CMSG_MODEL: 'm',
  });
  assert.match(explicit.stdout, /^chore: /);
  await assert.rejects(run(['--local', '--hint', 'invent intent'], cwd, env), /--hint/);
});

test('test command uses a fixed sample outside Git for both protocols and keeps JSON and keys clean', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'commitpick-cli-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'private.txt'), 'private-workspace-marker');
  const requests: { url?: string; body: Record<string, any> }[] = [];
  let responseStatus = 200;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    const content = JSON.stringify({ messages: ['docs: add example greeting'] });
    res.end(
      JSON.stringify(
        responseStatus !== 200
          ? { error: { message: 'secret-test-key' } }
          : req.url?.endsWith('/responses')
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const env = {
    ...process.env,
    CMSG_CONFIG: join(cwd, 'missing.json'),
    CMSG_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom/v1`,
    CMSG_MODEL: 'test-model',
    CMSG_API_KEY: 'secret-test-key',
    CMSG_PROTOCOL: 'responses',
  };
  for (const protocol of ['responses', 'chat-completions']) {
    const result = await run(['test', '--json'], cwd, { ...env, CMSG_PROTOCOL: protocol });
    const data = JSON.parse(result.stdout);
    assert.equal(data.protocol, protocol);
    assert.deepEqual(data.messages, ['docs: add example greeting']);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-test-key/);
    const request = requests.at(-1)!;
    assert.equal(
      request.url,
      `/custom/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
    );
    assert.doesNotMatch(JSON.stringify(request.body), /private-workspace-marker|private.txt/);
  }
  assert.equal(requests.length, 2);
  const displayed = await run(['config'], cwd, env);
  assert.match(displayed.stdout, /"protocol": "responses"/);
  assert.doesNotMatch(displayed.stdout, /secret-test-key/);
  const human = await run(['test'], cwd, env);
  assert.match(human.stderr, /测试通过/);
  assert.match(human.stdout, /docs: add example greeting/);
  responseStatus = 403;
  await assert.rejects(
    run(['test', '--json'], cwd, env),
    (error: Error & { stdout: string; stderr: string }) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /403/);
      assert.doesNotMatch(error.stderr, /secret-test-key/);
      return true;
    },
  );
  assert.equal(requests.length, 4);
  await assert.rejects(
    run(['test'], cwd, { ...env, CMSG_BASE_URL: '', CMSG_MODEL: '' }),
    (error: Error & { stderr: string }) => {
      assert.match(error.stderr, /cmsg setup/);
      return true;
    },
  );
  assert.equal(requests.length, 4);
});
