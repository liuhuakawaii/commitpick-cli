import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
// Context budgets select detail, never reject a change set or omit file operations.
const FULL_CONTEXT_BYTES = 24_000;
const DETAIL_BYTES = 20_000;
const FILE_DETAIL_BYTES = 8_000;
export type Scope = 'auto' | 'staged' | 'worktree';
export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  previousPath?: string;
}
export interface Changes {
  scope: Exclude<Scope, 'auto'>;
  diff: string;
  root: string;
  summarized: boolean;
  files: ChangedFile[];
}

function gitOptions(cwd: string) {
  return {
    cwd,
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const pending = execute('git', ['-c', 'core.quotepath=false', ...args], {
    ...gitOptions(cwd),
    encoding: 'utf8',
    maxBuffer: 16_000_000,
  });
  pending.child.stdin?.end();
  return (await pending).stdout;
}

function prefix(text: string, bytes: number): string {
  // Streaming decoding leaves an incomplete final UTF-8 character out of the excerpt.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, Math.max(0, bytes)), {
    stream: true,
  });
}

function evenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  if (count <= 1) return items.slice(0, count);
  return Array.from(
    { length: count },
    (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]!,
  );
}

class FileChange {
  metadata: string[] = [];
  added = 0;
  removed = 0;
  full: string | null = '';
  private fullBytes = 0;
  private hunk = '';
  private block = '';
  private blockLines = 0;
  private blockIndex = 0;
  private stride = 1;
  private samples: { index: number; text: string }[] = [];
  private last = '';

  constructor(readonly generated: boolean) {}

  detail(line: string, clipped: boolean) {
    if (line.startsWith('+')) this.added++;
    if (line.startsWith('-')) this.removed++;
    if (this.generated) return;
    this.fullBytes += Buffer.byteLength(line) + 1;
    this.full =
      this.full !== null && !clipped && this.fullBytes <= FILE_DETAIL_BYTES
        ? this.full + line + '\n'
        : null;
    if (line.startsWith('@@')) {
      this.flush();
      this.hunk = line;
      return;
    }
    if (!this.blockLines) this.block = this.hunk ? `${this.hunk}\n` : '';
    // Sample short windows throughout a large file, rather than only its beginning.
    if (this.block.length < 1200) {
      this.block += line.length > 300 ? line.slice(0, 300) + ' [line excerpt]\n' : line + '\n';
    }
    if (++this.blockLines === 16) this.flush();
  }

  private flush() {
    if (!this.blockLines) return;
    const index = this.blockIndex++;
    this.last = this.block;
    if (index % this.stride === 0) this.samples.push({ index, text: this.block });
    if (this.samples.length > 24) {
      this.stride *= 2;
      this.samples = this.samples.filter((sample) => sample.index % this.stride === 0);
    }
    this.blockLines = 0;
    this.block = '';
  }

  omitContent() {
    this.full = null;
    this.samples = [];
    this.block = '';
    this.blockLines = 0;
    this.last = '';
    this.added = this.removed = 0;
  }

  render(budget: number): string {
    this.flush();
    if (this.full !== null && Buffer.byteLength(this.full) <= budget) return this.full;
    if (budget < 200) return '';
    const samples = this.samples.map((sample) => sample.text);
    if (this.last && samples.at(-1) !== this.last) samples.push(this.last);
    const selected = evenly(samples, Math.max(1, Math.floor(budget / 1800)));
    const allowance = Math.floor((budget - 80) / Math.max(1, selected.length)) - 40;
    return (
      '[Partial patch excerpts; intervening lines omitted]\n' +
      selected.map((sample) => prefix(sample, allowance) + '\n[... omitted ...]\n').join('')
    );
  }
}

class ChangeContext {
  files: FileChange[] = [];
  full: string | null = '';
  private bytes = 0;

  append(line: string, clipped = false) {
    this.bytes += Buffer.byteLength(line) + 1;
    this.full =
      this.full !== null && !clipped && this.bytes <= FULL_CONTEXT_BYTES
        ? this.full + line + '\n'
        : null;
  }

  start(header: string): FileChange {
    const generated =
      /(?:^|\/)(?:dist|build|coverage|\.next)\/|public\/[^ ]*assets\/|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^ /]+\.min\.js|[^ /]+\.map)(?:[ "\\]|$)/.test(
        header,
      );
    const file = new FileChange(generated);
    // Generated content is never useful for a short subject, even in a small diff.
    if (generated) this.full = null;
    file.metadata.push(header);
    this.files.push(file);
    this.append(header);
    return file;
  }

  render(): { diff: string; summarized: boolean } {
    if (this.full !== null) return { diff: this.full, summarized: false };
    const overview = this.files
      .map(
        (file, i) =>
          `[File ${i + 1}]\n${file.metadata.join('\n')}\nChanged lines: +${file.added} -${file.removed}` +
          (file.generated ? '\nGenerated/lockfile path: content omitted.' : ''),
      )
      .join('\n\n');
    const details: string[] = [];
    let budget = DETAIL_BYTES;
    const candidates = this.files
      .map((file, i) => ({ file, i }))
      .filter(({ file }) => !file.generated)
      .sort((a, b) => (a.file.full?.length ?? Infinity) - (b.file.full?.length ?? Infinity));
    for (const [position, { file, i }] of candidates.entries()) {
      const text = file.render(Math.floor(budget / (candidates.length - position)));
      if (text) {
        details.push(`[File ${i + 1}: patch detail]\n${text}`);
        budget -= Buffer.byteLength(text);
      }
    }
    return {
      diff:
        'Large change set: all file operations are listed below. Patch detail may be excerpted or omitted; do not infer unseen behavior.\n\n' +
        overview +
        '\n\n' +
        details.join('\n'),
      summarized: true,
    };
  }
}

// Bound individual lines too: a minified bundle can contain megabytes on one line.
async function* lines(chunks: AsyncIterable<Buffer>, fatal = false) {
  const decoder = new TextDecoder('utf-8', { fatal });
  let pending = '';
  let clipped = false;
  for await (const chunk of chunks) {
    const parts = decoder.decode(chunk, { stream: true }).split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (pending.length + part.length > 4096) clipped = true;
      pending += part.slice(0, Math.max(0, 4096 - pending.length));
      if (i < parts.length - 1) {
        yield { line: pending + (clipped ? ' [line excerpt; remainder omitted]' : ''), clipped };
        pending = '';
        clipped = false;
      }
    }
  }
  pending += decoder.decode();
  if (pending || clipped) yield { line: pending, clipped };
}

async function readPatch(root: string, args: string[], context: ChangeContext) {
  const child = spawn('git', ['-c', 'core.quotepath=false', ...args], gitOptions(root));
  child.stdin.end();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 8192);
  });
  // Resolve errors as values so an early spawn failure cannot become an unhandled rejection.
  const finished = new Promise<Error | null>((resolve) => {
    child.on('error', resolve);
    child.on('close', (code) =>
      resolve(
        code === 0 ? null : new Error(`Git diff 读取失败：${stderr.trim() || `exit ${code}`}`),
      ),
    );
  });
  let file: FileChange | undefined;
  let inHunk = false;
  try {
    for await (const { line, clipped } of lines(child.stdout)) {
      if (line.startsWith('diff --git ')) {
        file = context.start(line);
        inHunk = false;
      } else {
        context.append(line, clipped);
        if (line.startsWith('@@')) inHunk = true;
        if (inHunk) file?.detail(line, clipped);
        else file?.metadata.push(line);
      }
    }
    const error = await finished;
    if (error) throw error;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function untrackedDiff(root: string, path: string, context: ChangeContext) {
  const absolute = join(root, path);
  const stat = await lstat(absolute);
  const file = context.start(`Untracked new file: ${JSON.stringify(path)}`);
  const metadata = (text: string) => {
    file.metadata.push(text);
    if (!file.generated) context.append(text);
  };
  if (stat.isSymbolicLink()) {
    metadata(`Symbolic link target: ${await readlink(absolute)}`);
    return;
  }
  if (!stat.isFile())
    throw new Error(`无法读取新文件 ${JSON.stringify(path)}，请先将需要的内容暂存。`);
  const handle = await open(absolute, 'r');
  try {
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).includes(0)) {
      metadata(`Binary file (${stat.size} bytes); content omitted.`);
      return;
    }
    metadata(`New file size: ${stat.size} bytes`);
    const stream = handle.createReadStream({ start: 0, autoClose: false });
    try {
      for await (const { line, clipped } of lines(stream, true)) {
        if (!file.generated) context.append('+' + line, clipped);
        file.detail('+' + line, clipped);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_ENCODING_INVALID_ENCODED_DATA')
        throw error;
      context.full = null;
      file.omitContent();
      metadata(`Non-UTF-8 file (${stat.size} bytes); content omitted.`);
    }
  } finally {
    await handle.close();
  }
}

async function changedFiles(root: string, args: string[]): Promise<ChangedFile[]> {
  const fields = (await git(root, [...args, '--name-status', '-z', '--'])).split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!.charAt(0);
    if (!['A', 'M', 'D', 'R', 'C', 'T'].includes(status))
      throw new Error('Git 返回了无法识别的文件操作。');
    const first = fields[i++]!;
    if (status === 'R' || status === 'C')
      files.push({ status, previousPath: first, path: fields[i++]! });
    else files.push({ status: status as ChangedFile['status'], path: first });
  }
  return files;
}

export async function collectChanges(
  cwd: string,
  requested: Scope = 'auto',
  options: { metadataOnly?: boolean } = {},
): Promise<Changes> {
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
  let args = [...diffArgs, '--cached'];
  let files = requested !== 'worktree' ? await changedFiles(root, args) : [];
  const scope = requested === 'auto' ? (files.length ? 'staged' : 'worktree') : requested;
  let untracked: string[] = [];
  if (scope === 'staged') {
    if (!files.length)
      throw new Error('暂存区没有改动，请先 git add <文件>，或使用 cmsg --worktree。');
  } else {
    let base = 'HEAD';
    try {
      await git(root, ['rev-parse', '--verify', 'HEAD']);
    } catch (error) {
      if ((error as { code?: number }).code !== 128) throw error;
      base = (await git(root, ['hash-object', '-t', 'tree', '--stdin'])).trim();
    }
    args = [...diffArgs, base];
    files = await changedFiles(root, args);
    untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    for (const path of untracked) files.push({ status: 'A', path });
  }
  if (!files.length) throw new Error('没有可生成提交信息的改动。');
  if (options.metadataOnly) return { scope, root, files, diff: '', summarized: false };
  const context = new ChangeContext();
  await readPatch(root, [...args, '--'], context);
  for (const file of untracked) await untrackedDiff(root, file, context);
  return { scope, root, files, ...context.render() };
}
