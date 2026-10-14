import { execFile } from 'node:child_process';
import { join } from 'node:path';

export async function copyToClipboard(
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      const { default: clipboard } = await import('clipboardy');
      await clipboard.write(text);
    } catch (error) {
      throw new Error('剪贴板不可用。', { cause: error });
    }
    return;
  }
  const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'clip.exe');
  await new Promise<void>((resolve, reject) => {
    let inputError: Error | undefined;
    const child = execFile(
      command,
      [],
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? 2000,
      },
      (error) => {
        if (error || inputError) {
          reject(
            new Error(error?.killed ? '剪贴板复制超时，已终止复制进程。' : '剪贴板不可用。', {
              cause: error ?? inputError,
            }),
          );
        } else resolve();
      },
    );
    child.stdin!.on('error', (error: Error) => {
      inputError = error;
    });
    // Conventional Commit subjects start with ASCII; their UTF-16LE byte pattern
    // is recognized by clip.exe. A BOM would be copied as an invisible character.
    child.stdin!.end(Buffer.from(text, 'utf16le'));
  });
}
