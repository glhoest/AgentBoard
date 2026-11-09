import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../scripts/lib/lock';
import { BoardError } from '../../scripts/lib/types';

function thrownBy(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error('expected a throw');
}

describe('withLock', () => {
  test('serializes independent Bun processes and keeps lock file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    const counter = join(root, 'counter');
    writeFileSync(counter, '0');
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, 'tests/ts/lock-fixtures/increment.ts', root, counter], { stdout: 'pipe', stderr: 'pipe' }));
    const exits = await Promise.all(children.map(c => c.exited));
    expect(exits).toEqual(Array(8).fill(0));
    expect(readFileSync(counter, 'utf8')).toBe('200');
    expect(existsSync(join(root, '.agentboard.lock'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('releases after callback throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    expect(() => withLock(root, () => { throw new Error('boom'); })).toThrow('boom');
    expect(withLock(root, () => 42)).toBe(42);
    expect(existsSync(join(root, '.agentboard.lock'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('passes errors from the callback through unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    try {
      const io = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      const thrownIo = thrownBy(() => withLock(root, () => { throw io; }));
      expect(thrownIo).toBe(io);
      expect(thrownIo).not.toBeInstanceOf(BoardError);
      const board = new BoardError('Board already exists');
      expect(thrownBy(() => withLock(root, () => { throw board; }))).toBe(board);
      expect(withLock(root, () => 'still usable')).toBe('still usable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is reentrant for the same root within a process, and released by the outermost call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    try {
      expect(withLock(root, () => withLock(join(root, '.'), () => withLock(root, () => 'nested')))).toBe('nested');
      expect(() => withLock(root, () => withLock(root, () => { throw new Error('inner'); }))).toThrow('inner');
      // Another process can take the lock now: nothing is left held.
      writeFileSync(join(root, 'counter'), '0');
      const child = Bun.spawn([process.execPath, 'tests/ts/lock-fixtures/increment.ts', root, join(root, 'counter')], { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(0);
      expect(readFileSync(join(root, 'counter'), 'utf8')).toBe('25');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('wraps failures to acquire the lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    try {
      const file = join(root, 'not-a-directory');
      writeFileSync(file, '');
      const error = thrownBy(() => withLock(file, () => 'never'));
      expect(error).toBeInstanceOf(BoardError);
      expect((error as Error).message).toStartWith(`Cannot lock ${file}: `);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is released when the holding process is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-lock-'));
    const holder = Bun.spawn([process.execPath, 'tests/ts/lock-fixtures/hold.ts', root], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = holder.stdout.getReader();
      let seen = '';
      while (!seen.includes('locked')) {
        const part = await reader.read();
        if (part.done) throw new Error('holder exited early');
        seen += new TextDecoder().decode(part.value);
      }
      holder.kill();
      await holder.exited;
      const start = Date.now();
      expect(withLock(root, () => 'acquired')).toBe('acquired');
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      holder.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
