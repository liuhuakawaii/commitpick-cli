import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Dynamic loading makes the initial missing-feature failure an explicit assertion.
async function collector() {
  const module = await import('../src/git.js').catch(() => null);
  assert.ok(module, 'Git change collector must be implemented');
  return module.collectChanges;
}

async function repo(t: { after: (fn: () => Promise<void>) => void }, initial = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'commitpick-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  if (initial) {
    await writeFile(join(cwd, 'app.ts'), 'export const value = "original";\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
  }
  return { cwd, git };
}

test('auto scope reads index content only, including partially staged files', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'app.ts'), 'export const value = "staged-value";\n');
  git('add', 'app.ts');
  await writeFile(join(cwd, 'app.ts'), 'export const value = "unstaged-secret-value";\n');
  await writeFile(join(cwd, 'new.ts'), 'untracked-content');
  const before = git('status', '--porcelain=v1');
  const result = await collect(cwd, 'auto');
  assert.equal(result.scope, 'staged');
  assert.match(result.diff, /staged-value/);
  assert.doesNotMatch(result.diff, /unstaged-secret-value|untracked-content/);
  assert.equal(git('status', '--porcelain=v1'), before);
});

test('auto falls back to working tree, includes untracked UTF-8 files, respects gitignore', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'app.ts'), 'export const value = "changed";\n');
  await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(cwd, 'ignored.txt'), 'DO-NOT-INCLUDE');
  await writeFile(join(cwd, '新 文件.ts'), 'export const 名称 = "中文内容";\n');
  await mkdir(join(cwd, 'nested'));
  const before = git('status', '--porcelain=v1');
  const result = await collect(join(cwd, 'nested'), 'auto');
  assert.equal(result.scope, 'worktree');
  assert.match(result.diff, /changed/);
  assert.match(result.diff, /中文内容/);
  assert.doesNotMatch(result.diff, /DO-NOT-INCLUDE/);
  assert.equal(git('status', '--porcelain=v1'), before);
});

test('explicit worktree describes net result relative to HEAD', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  await writeFile(join(cwd, 'app.ts'), 'intermediate\n');
  git('add', '.');
  await writeFile(join(cwd, 'app.ts'), 'final-value\n');
  const result = await collect(cwd, 'worktree');
  assert.match(result.diff, /final-value/);
  assert.doesNotMatch(result.diff, /intermediate/);
});

test(
  'unborn repository works for untracked and staged initial content',
  { timeout: 10_000 },
  async (t) => {
    const collect = await collector();
    const { cwd, git } = await repo(t, false);
    await writeFile(join(cwd, 'first.ts'), 'first-file\n');
    assert.match((await collect(cwd, 'auto')).diff, /first-file/);
    git('add', '.');
    assert.equal((await collect(cwd, 'auto')).scope, 'staged');
    assert.match((await collect(cwd, 'worktree')).diff, /first-file/);
  },
);

test('empty changes and explicit empty index have actionable errors', async (t) => {
  const collect = await collector();
  const { cwd } = await repo(t);
  await assert.rejects(collect(cwd, 'auto'), /没有.*改动/);
  await writeFile(join(cwd, 'new.ts'), 'new');
  await assert.rejects(collect(cwd, 'staged'), /暂存区/);
});

test('binary new files use metadata and oversized input fails instead of silently truncating', async (t) => {
  const collect = await collector();
  const { cwd } = await repo(t);
  await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 255]));
  const result = await collect(cwd, 'auto');
  assert.match(result.diff, /image.bin/);
  assert.match(result.diff, /binary/i);
  await writeFile(join(cwd, 'large.txt'), 'x'.repeat(180_000));
  await assert.rejects(collect(cwd, 'auto'), /过大|上限/);
});

test('deletions and renames are retained in the diff', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  git('mv', 'app.ts', 'renamed.ts');
  assert.match((await collect(cwd, 'auto')).diff, /rename (from|to)/);
  git('reset', '-q');
  await rm(join(cwd, 'renamed.ts'));
  assert.match((await collect(cwd, 'auto')).diff, /deleted file mode/);
});
