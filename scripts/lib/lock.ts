import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { BoardError } from './types';

const GENERIC_READ_WRITE = 0xC0000000;
const SHARE_ALL = 1 | 2 | 4;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE = -1n;
const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;
const RETRY_MS = 50;

type Release = () => void;

/**
 * Locks byte 0 of the lock file with LockFile, retrying until it is free.
 * On failure everything opened here is closed again; `fd` stays owned by the caller.
 * On success the returned release function unlocks and closes the handle and `fd`.
 */
function windowsLock(path: string, fd: number, nonblocking = false): Release | null {
  const dll = dlopen('kernel32.dll', {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    LockFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.bool },
    UnlockFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  });
  const wide = Buffer.from(path + '\0', 'utf16le');
  const handle = dll.symbols.CreateFileW(ptr(wide), GENERIC_READ_WRITE, SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
  if (handle === INVALID_HANDLE) {
    dll.close();
    throw new Error('CreateFileW failed');
  }

  try {
    while (!dll.symbols.LockFile(handle, 0, 0, 1, 0)) {
      if (nonblocking) { dll.symbols.CloseHandle(handle); dll.close(); return null; }
      Bun.sleepSync(RETRY_MS);
    }
  } catch (error) {
    dll.symbols.CloseHandle(handle);
    dll.close();
    throw error;
  }

  return () => {
    try {
      if (!dll.symbols.UnlockFile(handle, 0, 0, 1, 0)) throw new Error('UnlockFile failed');
    } finally {
      dll.symbols.CloseHandle(handle);
      dll.close();
      closeSync(fd);
    }
  };
}

/**
 * Takes an exclusive flock on `fd`, blocking until it is free.
 * `fd` stays owned by the caller on failure; the returned release function unlocks and closes it.
 */
function posixLock(fd: number, nonblocking = false): Release | null {
  const libraries = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib', 'libc.dylib'] : ['libc.so.6'];
  let lastError: unknown;
  for (const name of libraries) {
    try {
      const api = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      while (api.symbols.flock(fd, LOCK_EX | (nonblocking ? LOCK_NB : 0)) !== 0) {
        if (nonblocking) { api.close(); return null; }
        Bun.sleepSync(RETRY_MS);
      }
      return () => {
        try {
          if (api.symbols.flock(fd, LOCK_UN) !== 0) throw new Error('flock unlock failed');
        } finally {
          api.close();
          closeSync(fd);
        }
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function lockError(root: string, error: unknown): BoardError {
  if (error instanceof BoardError) return error;
  return new BoardError(`Cannot lock ${root}: ${error instanceof Error ? error.message : String(error)}`);
}

function acquire(root: string, nonblocking = false): Release | null {
  let fd: number | undefined;
  try {
    mkdirSync(root, { recursive: true });
    const path = join(root, '.agentboard.lock');
    fd = openSync(path, 'a+');
    const release = process.platform === 'win32' ? windowsLock(path, fd, nonblocking) : posixLock(fd, nonblocking);
    if (!release) { closeSync(fd); fd = undefined; return null; }
    fd = undefined; // now owned by release
    return release;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Report the acquisition failure, not the cleanup.
      }
    }
    throw lockError(root, error);
  }
}

// Roots whose lock this process currently holds. A second LockFile/flock on another handle of the
// same file would wait for ourselves forever, so nested withLock calls for one root run inline.
const held = new Set<string>();

/**
 * Runs `fn` while holding the board's OS lock on `<root>/.agentboard.lock`.
 *
 * Reentrant within a process: a nested call for the same root runs `fn` directly (callbacks are
 * synchronous, so nothing else can run in between). Upgrade-on-read relies on this: a read inside
 * a locked write can upgrade a file without a second lock.
 *
 * Only failures to acquire or release the lock become `BoardError("Cannot lock <root>: …")`.
 * Errors thrown by `fn` propagate unchanged (same object), so an IO error from a write stays
 * an IO error. If `fn` throws and releasing also fails, the release failure is dropped so it
 * cannot mask the original error (the OS frees the lock when the process exits anyway).
 * If `fn` succeeds and releasing fails, the release failure is thrown as a lock error.
 */
export function withLock<T>(root: string, fn: () => T): T {
  const key = resolve(root);
  if (held.has(key)) return fn();
  const release = acquire(root);
  if (!release) throw lockError(root, new Error('Lock unavailable'));
  held.add(key);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    held.delete(key);
    try {
      release();
    } catch {
      // Keep the callback's error; see above.
    }
    throw error;
  }
  held.delete(key);
  try {
    release();
  } catch (error) {
    throw lockError(root, error);
  }
  return result;
}

/** Try once; a busy or unavailable lock never blocks the caller. */
export function tryWithLock<T>(root: string, fn: () => T): T | null {
  const key = resolve(root);
  if (held.has(key)) return fn();
  const release = acquire(root, true);
  if (!release) return null;
  held.add(key);
  try { return fn(); }
  finally { held.delete(key); release(); }
}
