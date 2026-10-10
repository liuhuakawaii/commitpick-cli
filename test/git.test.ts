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

test('binary new files use metadata and large new files are summarized', async (t) => {
  const collect = await collector();
  const { cwd } = await repo(t);
  await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 255]));
  const result = await collect(cwd, 'auto');
  assert.match(result.diff, /image.bin/);
  assert.match(result.diff, /binary/i);
  await writeFile(join(cwd, 'large.txt'), 'x'.repeat(180_000));
  const large = await collect(cwd, 'auto');
  assert.equal(large.summarized, true);
  assert.match(large.diff, /large.txt/);
  assert.match(large.diff, /excerpt|omitted/i);
  assert.ok(Buffer.byteLength(large.diff) < 160_000);
});

test('large staged build assets keep every file operation and prioritize source changes', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  await mkdir(join(cwd, 'public/assets'), { recursive: true });
  await writeFile(join(cwd, 'public/assets/app-abc123.js'), 'oldBundle();\n'.repeat(30_000));
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'bundle');
  await rm(join(cwd, 'public/assets/app-abc123.js'));
  await writeFile(join(cwd, 'public/assets/app-def456.js'), 'newBundle();\n'.repeat(30_000));
  await writeFile(join(cwd, 'app.ts'), 'export const preventDuplicateRefresh = true;\n');
  git('add', '.');
  await writeFile(join(cwd, 'app.ts'), 'UNSTAGED_DO_NOT_INCLUDE\n');
  const before = git('status', '--porcelain=v1');
  const result = await collect(cwd);
  assert.equal(result.scope, 'staged');
  assert.equal(result.summarized, true);
  assert.match(result.diff, /app-abc123.js/);
  assert.match(result.diff, /app-def456.js/);
  assert.match(result.diff, /deleted file mode/);
  assert.match(result.diff, /new file mode/);
  assert.match(result.diff, /preventDuplicateRefresh/);
  assert.doesNotMatch(result.diff, /UNSTAGED_DO_NOT_INCLUDE|oldBundle\(\)|newBundle\(\)/);
  assert.ok(Buffer.byteLength(result.diff) < 160_000);
  assert.equal(git('status', '--porcelain=v1'), before);
});

test('large source changes retain excerpts across the file, including the last change', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  await writeFile(
    join(cwd, 'app.ts'),
    'export const firstBehavior = true;\n' +
      'export const repeated = 1;\n'.repeat(20_000) +
      'export const finalBehavior = true;\n',
  );
  git('add', '.');
  const result = await collect(cwd);
  assert.equal(result.summarized, true);
  assert.match(result.diff, /firstBehavior/);
  assert.match(result.diff, /finalBehavior/);
  assert.match(result.diff, /excerpt|omitted/i);
  assert.ok(Buffer.byteLength(result.diff) < 160_000);
});

test('more than 200 untracked files remain usable and include the last file', async (t) => {
  const collect = await collector();
  const { cwd } = await repo(t);
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      writeFile(join(cwd, `file-${i}.ts`), `export const value${i} = ${i};\n`),
    ),
  );
  const result = await collect(cwd);
  for (let i = 0; i < 205; i++) assert.ok(result.diff.includes(`file-${i}.ts`));
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

test('large worktree context uses final content and retains UTF-8 rename paths', async (t) => {
  const collect = await collector();
  const { cwd, git } = await repo(t);
  git('mv', 'app.ts', '重命名 文件.ts');
  await writeFile(join(cwd, 'controller.ts'), 'intermediate-value\n');
  git('add', '.');
  await writeFile(join(cwd, 'controller.ts'), 'final-behavior\n');
  await writeFile(join(cwd, 'huge.min.js'), 'x'.repeat(2_000_000));
  const result = await collect(cwd, 'worktree');
  assert.equal(result.summarized, true);
  assert.match(result.diff, /重命名 文件.ts/);
  assert.match(result.diff, /rename (from|to)/);
  assert.match(result.diff, /final-behavior/);
  assert.doesNotMatch(result.diff, /intermediate-value/);
});

test('invalid UTF-8 late in a large new file discards partial decoded content', async (t) => {
  const collect = await collector();
  const { cwd } = await repo(t);
  await writeFile(
    join(cwd, 'legacy.txt'),
    Buffer.concat([
      Buffer.from('DO_NOT_SEND_PARTIAL_LEGACY_CONTENT\n'.repeat(6000)),
      Buffer.from([0xff]),
    ]),
  );
  const result = await collect(cwd);
  assert.match(result.diff, /legacy.txt/);
  assert.match(result.diff, /Non-UTF-8/);
  assert.doesNotMatch(result.diff, /DO_NOT_SEND_PARTIAL_LEGACY_CONTENT/);
});
