import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessages } from '../src/ai.js';

async function localModule() {
  const module = await import('../src/local.js').catch(() => null);
  assert.ok(module, 'local generation module must be implemented');
  return module;
}

test('local rules generate distinct bilingual subjects for the complete file operation set', async () => {
  const { generateLocalMessages } = await localModule();
  const files = [
    { status: 'A' as const, path: 'src/a.ts' },
    { status: 'M' as const, path: 'src/b.ts' },
    { status: 'D' as const, path: 'old.ts' },
  ];
  for (const language of ['en', 'zh'] as const) {
    for (const count of [1, 3, 5]) {
      const messages = generateLocalMessages(files, { language, count });
      assert.deepEqual(parseMessages(JSON.stringify({ messages }), count), messages);
      for (const message of messages) {
        assert.match(message, /^chore: /);
        assert.match(
          message,
          language === 'en' ? /add|introduce|create|include|bring in/ : /新增|添加|增加|加入|新建/,
        );
        assert.match(
          message,
          language === 'en' ? /delete|remove|drop|erase|discard/ : /删除|移除|删去|去除|清除/,
        );
      }
    }
  }
});

test('local rules classify only unambiguous file categories and preserve rename semantics', async () => {
  const { generateLocalMessages } = await localModule();
  for (const [path, type] of [
    ['docs/guide.md', 'docs'],
    ['test/app.test.ts', 'test'],
    ['.github/workflows/ci.yml', 'ci'],
    ['src/auth.ts', 'chore'],
  ]) {
    const messages = generateLocalMessages([{ status: 'M', path: path! }], {
      language: 'en',
      count: 3,
    });
    assert.ok(
      messages.every((message) => message.startsWith(type + ': ') && message.includes(path!)),
    );
  }
  const renamed = generateLocalMessages(
    [{ status: 'R', path: 'docs/new.md', previousPath: 'src/old.ts' }],
    { language: 'en', count: 3 },
  );
  assert.ok(
    renamed.every(
      (message) =>
        message.startsWith('chore: ') &&
        message.includes('src/old.ts') &&
        message.includes('docs/new.md'),
    ),
  );
});

test('local subjects remain single-line, bounded and distinct for unusual names and large inventories', async () => {
  const { generateLocalMessages } = await localModule();
  for (const files of [
    [{ status: 'A' as const, path: 'src/中文\n\u001b\u2028文件.ts' }],
    [{ status: 'R' as const, path: '新'.repeat(200), previousPath: '旧'.repeat(200) }],
    Array.from({ length: 250 }, (_, i) => ({ status: 'M' as const, path: `src/file${i}.ts` })),
    ['A', 'M', 'D', 'R', 'C', 'T'].map((status) => ({
      status: status as 'A',
      path: 'p'.repeat(200),
    })),
  ]) {
    for (const language of ['en', 'zh'] as const) {
      const messages = generateLocalMessages(files, { language, count: 5 });
      assert.deepEqual(parseMessages(JSON.stringify({ messages }), 5), messages);
    }
  }
});
