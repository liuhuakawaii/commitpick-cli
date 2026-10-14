import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { generateMessages, type TokenUsage } from '../src/ai.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--run')) throw new Error('用法：npm run evaluate [-- --run]');
const live = args.includes('--run');
const fixtures = JSON.parse(
  await readFile(new URL('../test/fixtures/quality.json', import.meta.url), 'utf8'),
) as {
  id: string;
  revision: string;
  path: string;
  checks: string[];
  diff: string;
}[];
// Explicit live mode sends only these checked-in historical patches, never workspace changes.
const config = live ? await loadConfig() : null;
if (live && !config) throw new Error('尚未配置 AI，请运行 cmsg setup。');
const cases = [];
let requests = 0;
for (const fixture of fixtures) {
  const started = performance.now();
  let usage: TokenUsage | undefined;
  let messages: string[] | undefined;
  let failed = false;
  if (config) {
    requests++;
    console.error(`评估 ${fixture.id}…`);
    try {
      messages = await generateMessages({ ...config, language: 'both', count: 4 }, fixture.diff, {
        onUsage: (value) => {
          usage = value;
        },
      });
    } catch (error) {
      failed = true;
      process.exitCode = 1;
      console.error(`${fixture.id}：${error instanceof Error ? error.message : '请求失败'}`);
    }
  }
  cases.push({
    id: fixture.id,
    revision: fixture.revision,
    path: fixture.path,
    inputBytes: Buffer.byteLength(fixture.diff),
    checks: fixture.checks,
    semanticReview: null,
    ...(live
      ? { elapsedMs: Math.round(performance.now() - started), failed, messages, usage }
      : {}),
  });
}
console.log(JSON.stringify({ mode: live ? 'live' : 'prepare', requests, cases }, null, 2));
