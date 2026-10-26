import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences } from '../src/config.js';

test('legacy preferences keep their language allocation until explicitly saved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'commitpick-preferences-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  assert.deepEqual(await loadPreferences(path), { englishCount: 1, chineseCount: 0 });
  for (const [language, count, expected] of [
    ['both', 3, { englishCount: 2, chineseCount: 1 }],
    ['zh', 2, { englishCount: 0, chineseCount: 2 }],
    ['en', 5, { englishCount: 5, chineseCount: 0 }],
  ] as const) {
    const original = JSON.stringify({ language, count });
    await writeFile(`${path}.preferences.json`, original);
    const loaded = await loadPreferences(path);
    assert.deepEqual(loaded, expected);
    assert.equal(await readFile(`${path}.preferences.json`, 'utf8'), original);
    await savePreferences(loaded, path);
    assert.deepEqual(JSON.parse(await readFile(`${path}.preferences.json`, 'utf8')), expected);
  }
  for (const invalid of [
    { language: ['en'], count: 1 },
    { englishCount: 0, chineseCount: 0 },
    { englishCount: 1.5, chineseCount: 0 },
    { englishCount: 4, chineseCount: 2 },
    { englishCount: -1, chineseCount: 1 },
    { englishCount: 1 },
    { englishCount: '1', chineseCount: 0 },
  ]) {
    await writeFile(`${path}.preferences.json`, JSON.stringify(invalid));
    await assert.rejects(loadPreferences(path), /无法读取通用偏好/);
  }
});
