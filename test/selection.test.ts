import { test } from 'node:test';
import assert from 'node:assert/strict';

async function selectionModule() {
  const module = await import('../src/selection.js').catch(() => null);
  assert.ok(module, 'candidate interaction must be available');
  return module;
}

test('selection offers copy, regeneration and preview without candidate editing', async () => {
  const { selectMessage } = await selectionModule();
  let previews = 0;
  let menus = 0;
  const initial = ['fix: prevent duplicate refresh'];
  const result = await selectMessage(
    initial,
    {
      select: async ({ choices }) => {
        assert.deepEqual(
          choices.map((choice) => choice.value),
          ['copy:0', 'hint', 'retry', 'preview'],
        );
        return menus++ === 0 ? 'preview' : 'copy:0';
      },
      input: async () => {
        throw new Error('selection must not open an editor');
      },
      output: () => {},
    },
    {
      regenerate: async () => {
        throw new Error('selection must not request AI');
      },
      preview: () => {
        previews++;
      },
    },
  );
  assert.equal(result, initial[0]);
  assert.equal(previews, 1);
});

test('regeneration failure keeps previous candidates and retains an explicit hint', async () => {
  const { selectMessage } = await selectionModule();
  const choices = ['hint', 'retry', 'copy:0'];
  const hints: (string | undefined)[] = [];
  const errors: string[] = [];
  const result = await selectMessage(
    ['fix: original wording'],
    {
      select: async () => choices.shift()!,
      input: async () => 'reuse the pending request',
      output: (text) => errors.push(text),
    },
    {
      regenerate: async (hint) => {
        hints.push(hint);
        if (hints.length === 1) throw new Error('connection failed');
        return ['fix: reuse pending request'];
      },
    },
  );
  assert.deepEqual(hints, ['reuse the pending request', 'reuse the pending request']);
  assert.ok(errors.some((text) => text.includes('connection failed')));
  assert.equal(result, 'fix: reuse pending request');
});
