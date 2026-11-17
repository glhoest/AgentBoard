import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import { main } from '../../scripts/agentboard';

test('dependency mutations validate references and cycles and readiness reports dangling links', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-deps-'));
  try {
    store.init(root);
    const a = store.create(root, { title: 'A' });
    const b = store.create(root, { title: 'B' });
    const c = store.create(root, { title: 'C' });
    store.changeDependency(root, a.id, b.id, null, true);
    store.changeDependency(root, b.id, c.id, null, true);
    expect(() => store.changeDependency(root, c.id, a.id, null, true)).toThrow('cycle');
    expect(() => store.changeDependency(root, a.id, a.id, null, true)).toThrow();
    expect(() => store.changeDependency(root, a.id, 'AB-000000000000', null, true)).toThrow('does not exist');
    expect(() => store.changeDependency(root, a.id, b.id, 1, false)).toThrow('Revision mismatch');
    const run = (...args: string[]) => {
      const out: string[] = [];
      const code = main(['--root', root, '--quiet', '--json', ...args], { out: x => out.push(x), err: () => {}, env: {} });
      expect(code).toBe(0);
      return JSON.parse(out.join('\n'));
    };
    expect(run('dependencies', a.id).blockers.map((x: any) => x.id)).toEqual([b.id]);
    store.update(root, b.id, null, { archived: true });
    expect(run('dependencies', a.id).blockers).toEqual([]);
    unlinkSync(join(root, '.agentboard', 'items', b.id + '.json'));
    const summary = run('dependencies', a.id);
    expect(summary.dependencies[0].missing).toBe(true);
    expect(summary.blockers).toEqual([]);
    store.changeDependency(root, a.id, b.id, null, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
