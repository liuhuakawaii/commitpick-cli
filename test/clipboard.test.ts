import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

test(
  'Windows clipboard sends exact Unicode text over stdin without starting PowerShell or a shell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const module = await import('../src/clipboard.js').catch(() => null);
    assert.ok(module, 'clipboard module must be implemented');
    const original = childProcess.execFile;
    let received = '';
    t.mock.method(
      childProcess,
      'execFile',
      (command: string, args: string[], options: object, callback: (...args: any[]) => void) => {
        assert.equal(basename(command).toLowerCase(), 'clip.exe');
        assert.deepEqual(args, []);
        assert.equal((options as { windowsHide: boolean }).windowsHide, true);
        assert.notEqual((options as { shell?: boolean }).shell, true);
        return original(
          process.execPath,
          [
            '-e',
            'const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks).toString("base64")));',
          ],
          options,
          (error, stdout, stderr) => {
            received = Buffer.from(String(stdout), 'base64').toString('utf16le');
            callback(error, stdout, stderr);
          },
        );
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const text = 'fix: 修复中文与引号 " $HOME & | < >';
    await module.copyToClipboard(text);
    assert.equal(received, text);
  },
);

test(
  'Windows clipboard timeout terminates the child and returns a useful failure',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const module = await import('../src/clipboard.js').catch(() => null);
    assert.ok(module, 'clipboard module must be implemented');
    const original = childProcess.execFile;
    let child: childProcess.ChildProcess | undefined;
    t.mock.method(
      childProcess,
      'execFile',
      (_command: string, _args: string[], options: object, callback: (...args: any[]) => void) => {
        child = original(
          process.execPath,
          ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
          options,
          callback,
        );
        return child;
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      child?.kill();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(module.copyToClipboard('fix: bounded copy', { timeoutMs: 200 }), /超时/);
    assert.ok(child?.killed);
    assert.throws(() => process.kill(child!.pid!, 0), { code: 'ESRCH' });
  },
);

test(
  'Windows clipboard reports command failures and does not claim success',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const module = await import('../src/clipboard.js').catch(() => null);
    assert.ok(module, 'clipboard module must be implemented');
    const original = childProcess.execFile;
    t.mock.method(
      childProcess,
      'execFile',
      (_command: string, _args: string[], options: object, callback: (...args: any[]) => void) =>
        original(
          process.execPath,
          ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(1))'],
          options,
          callback,
        ),
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await assert.rejects(module.copyToClipboard('fix: failed copy'), /剪贴板/);
  },
);
