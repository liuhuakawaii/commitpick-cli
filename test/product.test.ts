import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectChanges } from '../src/git.js';
import { generateLocalMessages } from '../src/local.js';

const execute = promisify(execFile);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'commitpick-product-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  const env = {
    ...process.env,
    CMSG_CONFIG: join(cwd, '.git', 'config.json'),
    CMSG_BASE_URL: '',
    CMSG_MODEL: '',
    CMSG_PROTOCOL: '',
    CMSG_API_KEY: '',
  };
  async function run(args: string[]) {
    const pending = execute(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli.ts'), ...args],
      { cwd, env, windowsHide: true },
    );
    pending.child.stdin?.end();
    return pending;
  }
  return { cwd, env, run };
}

test('default CLI returns two English then two Chinese candidates without changing Git', async (t) => {
  const { cwd, run } = await fixture(t);
  await writeFile(join(cwd, 'app.ts'), 'export const flag = true;\n');
  const before = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  const { stdout } = await run(['--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.languages, ['en', 'en', 'zh', 'zh']);
  assert.ok(result.messages.slice(0, 2).every((m: string) => !/\p{Script=Han}/u.test(m)));
  assert.ok(result.messages.slice(2).every((m: string) => /\p{Script=Han}/u.test(m)));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), before);
});

test('language overrides and odd counts have a stable documented order', async (t) => {
  const { cwd, run } = await fixture(t);
  await writeFile(join(cwd, 'app.ts'), 'change');
  for (const [args, expected] of [
    [
      ['cn', '-n', '2'],
      ['zh', 'zh'],
    ],
    [['en', '-n', '1'], ['en']],
    [
      ['both', '-n', '3'],
      ['en', 'en', 'zh'],
    ],
    [
      ['both', '-n', '5'],
      ['en', 'en', 'en', 'zh', 'zh'],
    ],
  ]) {
    const result = JSON.parse((await run([...args!, '--local', '--json'])).stdout);
    assert.deepEqual(result.languages, expected);
    assert.equal(result.messages.length, expected!.length);
  }
});

test('local candidates retain the common directory and file names', () => {
  const result = generateLocalMessages(
    [
      { status: 'M', path: 'src/auth.ts' },
      { status: 'M', path: 'src/token.ts' },
    ],
    { language: 'en', count: 2 },
  );
  assert.ok(
    result.every(
      (message) =>
        message.includes('src/') && message.includes('auth.ts') && message.includes('token.ts'),
    ),
  );
});

test('local directory summary never invents a prefix from matching later segments', () => {
  const files = [
    'src/shared/a.ts',
    'other/shared/b.ts',
    'src/shared/c.ts',
    'other/shared/d.ts',
  ].map((path) => ({ status: 'M' as const, path }));
  const messages = generateLocalMessages(files, { language: 'en', count: 2 });
  assert.ok(messages.every((message) => !message.includes('(shared/)')));
});

test('preferences can be saved without AI and still work with a broken AI config', async (t) => {
  const { cwd, env, run } = await fixture(t);
  await writeFile(join(cwd, 'app.ts'), 'change');
  await run(['config', '--lang', 'zh', '--count', '2']);
  await writeFile(env.CMSG_CONFIG, '{broken');
  const result = JSON.parse((await run(['--local', '--json'])).stdout);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.languages, ['zh', 'zh']);
  assert.equal(await readFile(env.CMSG_CONFIG, 'utf8'), '{broken');
});

test('preview shows exact input and selected files without needing valid AI configuration', async (t) => {
  const { cwd, env, run } = await fixture(t);
  await writeFile(join(cwd, 'app.ts'), 'VISIBLE_SOURCE');
  await writeFile(env.CMSG_CONFIG, '{broken');
  const result = JSON.parse((await run(['--preview', '--json'])).stdout);
  assert.equal(result.scope, 'worktree');
  assert.equal(result.files[0].path, 'app.ts');
  assert.match(result.diff, /VISIBLE_SOURCE/);
  assert.equal(result.inputBytes, Buffer.byteLength(result.diff));
  assert.equal(result.messages, undefined);
});

test('even small generated assets are metadata only, with source detail retained', async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, 'app.ts'), 'export const behavior = true;\n');
  await writeFile(join(cwd, 'package-lock.json'), '{"privateGeneratedMarker":true}\n');
  const result = await collectChanges(cwd);
  assert.match(result.diff, /package-lock.json/);
  assert.doesNotMatch(result.diff, /privateGeneratedMarker/);
  assert.match(result.diff, /behavior/);
});

test('medium source input is budgeted while keeping first and last behavior', async (t) => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, 'src'));
  await writeFile(
    join(cwd, 'src/app.ts'),
    'export const firstBehavior = true;\n' +
      'export const filler = 1;\n'.repeat(3000) +
      'export const lastBehavior = true;\n',
  );
  const result = await collectChanges(cwd);
  assert.ok(Buffer.byteLength(result.diff) < 25_000, 'source detail should use the compact budget');
  assert.match(result.diff, /firstBehavior/);
  assert.match(result.diff, /lastBehavior/);
  assert.equal(result.summarized, true);
});
