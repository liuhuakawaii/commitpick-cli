import { candidateLanguages, type Language } from './config.js';
import type { ChangedFile } from './git.js';

// These rules describe observable file operations, never infer a bug or feature.
const verbs = {
  en: {
    A: ['add', 'introduce', 'create', 'include', 'bring in'],
    M: ['modify', 'update', 'revise', 'change', 'adjust'],
    D: ['delete', 'remove', 'drop', 'erase', 'discard'],
    R: ['rename', 'change the path of', 'relocate', 'update the path of', 'move'],
    C: ['copy', 'duplicate', 'make copies of', 'add copies of', 'create copies of'],
    T: [
      'change the file type of',
      'update the file type of',
      'modify the file type of',
      'revise the file type of',
      'adjust the file type of',
    ],
  },
  zh: {
    A: ['新增', '添加', '增加', '加入', '新建'],
    M: ['修改', '更新', '修订', '调整', '变更'],
    D: ['删除', '移除', '删去', '去除', '清除'],
    R: ['重命名', '更改路径', '调整路径', '更新路径', '移动'],
    C: ['复制', '增加副本', '添加副本', '创建副本', '生成副本'],
    T: ['更改文件类型', '修改文件类型', '调整文件类型', '更新文件类型', '变更文件类型'],
  },
};

function category(path: string): string {
  if (/^(?:docs?\/|readme(?:\.|$)|license(?:\.|$)|changelog(?:\.|$))|\.(?:md|mdx|rst)$/i.test(path))
    return 'docs';
  if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^/]+$/i.test(path)) return 'test';
  if (/^(?:\.github\/workflows\/|\.gitlab-ci\.yml$)/.test(path)) return 'ci';
  return 'chore';
}

function displayPath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
}

export function generateLocalMessages(
  files: ChangedFile[],
  options: { language: Language; count: number },
): string[] {
  if (!files.length) throw new Error('没有可生成提交信息的改动。');
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 5)
    throw new Error('候选数量必须是 1 到 5 的整数。');
  const categories = new Set(
    files.flatMap((file) => [
      category(file.path),
      ...(file.previousPath ? [category(file.previousPath)] : []),
    ]),
  );
  const type = categories.size === 1 ? [...categories][0]! : 'chore';
  const groups = new Map<ChangedFile['status'], number>();
  for (const file of files) groups.set(file.status, (groups.get(file.status) ?? 0) + 1);
  const indices = { en: 0, zh: 0 };
  return candidateLanguages(options.language, options.count).map((language) => {
    const i = indices[language]++;
    const zh = language === 'zh';
    const clauses = [...groups].map(([status, count]) => {
      let target = zh ? `${count} 个文件` : `${count} ${count === 1 ? 'file' : 'files'}`;
      if (files.length === 1) {
        const file = files[0]!;
        target = file.previousPath
          ? `${displayPath(file.previousPath)} -> ${displayPath(file.path)}`
          : displayPath(file.path);
      } else {
        const group = files.filter((file) => file.status === status);
        const paths = group.map((file) =>
          file.previousPath
            ? `${displayPath(file.previousPath)} -> ${displayPath(file.path)}`
            : displayPath(file.path),
        );
        if (paths.length <= 3) target = paths.join(', ');
        else {
          const directories = group.map((file) => file.path.split('/').slice(0, -1));
          const shared: string[] = [];
          for (const [index, part] of directories[0]!.entries()) {
            if (!directories.every((parts) => parts[index] === part)) break;
            shared.push(part);
          }
          if (shared.length) target += ` (${displayPath(shared.join('/'))}/)`;
        }
      }
      return `${verbs[language][status][i]} ${target}`;
    });
    const detailed = `${type}: ${clauses.join(zh ? '，' : ', ')}`;
    if (Array.from(detailed).length <= 100) return detailed;
    // Keep every operation even when paths or the full wording would exceed the limit.
    const action = zh
      ? ['记录', '应用', '纳入', '更新', '整理'][i]
      : ['apply', 'record', 'include', 'capture', 'update'][i];
    return `${type}: ${action} ${zh ? '文件操作' : 'file operations'} (${[...groups].map(([status, count]) => `${status}:${count}`).join(', ')})`;
  });
}
