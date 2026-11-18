import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withLock } from './lock';

/** Stage the verified files and swap only the skill directory under the installation lock. */
export function replaceSkill<T>(target: string, files: Map<string, Uint8Array>, beforeReplace: () => T | null): T | null {
  const parent = dirname(target);
  const staging = mkdtempSync(join(parent, '.agentboard-update-'));
  const backup = join(parent, `.agentboard-backup-${randomUUID()}`);
  let moved = false;
  try {
    for (const [name, bytes] of files) {
      const output = join(staging, ...name.split('/'));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
    }
    return withLock(parent, () => {
      const skip = beforeReplace();
      if (skip !== null) return skip;
      renameSync(target, backup);
      moved = true;
      try {
        renameSync(staging, target);
      } catch (error) {
        try { renameSync(backup, target); moved = false; }
        catch { throw new Error(`Installation failed; restore the backup at ${backup}`); }
        throw error;
      }
      moved = false;
      try { rmSync(backup, { recursive: true, force: true }); } catch { /* The new installation is already active; leave the backup for manual cleanup. */ }
      return null;
    });
  } finally {
    if (!moved && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
