import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
const MAX_DIFF_BYTES = 160_000;
export type Scope = 'auto' | 'staged' | 'worktree';
export interface Changes {
  scope: Exclude<Scope, 'auto'>;
  diff: string;
  root: string;
}

function tooLarge(): Error {
  return new Error(
    '改动过大，超过 160 KB 分析上限。请用 git add -p 或 git add <文件> 缩小暂存范围，再运行 cmsg --staged。',
  );
}

async function git(cwd: string, args: string[], maxBuffer = 1_000_000): Promise<string> {
  try {
    const pending = execute('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer,
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw tooLarge();
    throw error;
  }
}

async function untrackedDiff(root: string, file: string, remaining: number): Promise<string> {
  const path = join(root, file);
  const stat = await lstat(path);
  const header = `\nUntracked new file: ${JSON.stringify(file)}\n`;
  if (stat.isSymbolicLink()) return `${header}Symbolic link target: ${await readlink(path)}\n`;
  if (!stat.isFile())
    throw new Error(`无法读取新文件 ${JSON.stringify(file)}，请先将需要的内容暂存。`);
  const handle = await open(path, 'r');
  try {
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).includes(0))
      return `${header}Binary file (${stat.size} bytes); content omitted.\n`;
    if (stat.size > remaining) throw tooLarge();
    // Bounded read also covers a file growing while the snapshot is being collected.
    const content = Buffer.alloc(remaining + 1);
    let length = 0;
    while (length < content.length) {
      const part = await handle.read(content, length, content.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > remaining) throw tooLarge();
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, length));
    } catch {
      return `${header}Non-UTF-8 file (${stat.size} bytes); content omitted.\n`;
    }
    return (
      header +
      decoded
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n') +
      '\n'
    );
  } finally {
    await handle.close();
  }
}

export async function collectChanges(cwd: string, requested: Scope = 'auto'): Promise<Changes> {
  let root: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('未找到 Git，请先安装 Git 并加入 PATH。');
    throw new Error('无法读取 Git 仓库；请在有访问权限的仓库目录中运行 cmsg。', { cause: error });
  }
  const conflicts = await git(root, ['ls-files', '--unmerged', '-z']);
  if (conflicts) throw new Error('存在未解决的合并冲突，请先解决冲突再生成提交信息。');
  const diffArgs = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=none',
    '--find-renames',
    '--unified=3',
  ];
  const staged =
    requested === 'worktree'
      ? ''
      : await git(root, [...diffArgs, '--cached', '--'], MAX_DIFF_BYTES);
  const scope = requested === 'auto' ? (staged ? 'staged' : 'worktree') : requested;
  if (scope === 'staged') {
    if (!staged.trim())
      throw new Error('暂存区没有改动，请先 git add <文件>，或使用 cmsg --worktree。');
    if (Buffer.byteLength(staged) > MAX_DIFF_BYTES) throw tooLarge();
    return { scope, diff: staged, root };
  }
  let base = 'HEAD';
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    if ((error as { code?: number }).code !== 128) throw error;
    // Git understands its empty tree hash even before the first commit, including SHA-256 repos.
    base = (await git(root, ['hash-object', '-t', 'tree', '--stdin'])).trim();
  }
  let diff = await git(root, [...diffArgs, base, '--'], MAX_DIFF_BYTES);
  const files = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  if (files.length > 200) throw tooLarge();
  for (const file of files) {
    const remaining = MAX_DIFF_BYTES - Buffer.byteLength(diff);
    if (remaining <= 0) throw tooLarge();
    diff += await untrackedDiff(root, file, remaining);
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw tooLarge();
  }
  if (!diff.trim()) throw new Error('没有可生成提交信息的改动。');
  return { scope, diff, root };
}
