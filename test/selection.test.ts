import { test } from 'node:test';
import assert from 'node:assert/strict';

async function selectionModule() {
  const module = await import('../src/selection.js').catch(() => null);
  assert.ok(module, 'candidate interaction must be available');
  return module;
}

test('editing validates the subject and returns it without regenerating', async () => {
  const { selectMessage } = await selectionModule();
  const choices = ['edit:0', 'copy:0'];
  const result = await selectMessage(['fix: prevent duplicate refresh'], {
    select: async () => choices.shift()!,
    input: async (options) => {
      assert.notEqual(options.validate?.('invalid'), true);
      assert.equal(options.validate?.('fix(auth): reuse pending refresh'), true);
      return 'fix(auth): reuse pending refresh';
    },
    output: () => {},
  });
  assert.equal(result, 'fix(auth): reuse pending refresh');
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
