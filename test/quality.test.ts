import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

test('quality preparation uses fixed history without network or user configuration', async () => {
  const pending = promisify(execFile)(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/evaluate.ts'],
    {
      env: {
        ...process.env,
        CMSG_BASE_URL: 'invalid',
        CMSG_MODEL: 'invalid',
        CMSG_CONFIG: 'nonexistent-eval-config.json',
      },
      windowsHide: true,
    },
  );
  pending.child.stdin?.end();
  const { stdout } = await pending;
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'prepare');
  assert.ok(report.cases.length >= 5);
  assert.ok(
    report.cases.every(
      (item: { inputBytes: number; checks: string[]; semanticReview: unknown }) =>
        item.inputBytes > 0 && item.checks.length > 0 && item.semanticReview === null,
    ),
  );
  assert.equal(report.requests, 0);
});
