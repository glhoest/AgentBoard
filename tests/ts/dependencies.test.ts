import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import { main } from '../../scripts/agentboard';
import { startBridge } from '../../scripts/lib/serve';

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
function cli(root: string, ...args: string[]) {
  return Bun.spawn(['bun', CLI, '--root', root, '--quiet', '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
}
async function output(process: ReturnType<typeof cli>) {
  const [code, out, err] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, out, err };
}

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


test('opposite links from separate CLI processes cannot both commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-deps-race-'));
  try {
    store.init(root);
    const a = store.create(root, { title: 'A' });
    const b = store.create(root, { title: 'B' });
    const results = await Promise.all([output(cli(root, 'dependency-add', a.id, b.id)), output(cli(root, 'dependency-add', b.id, a.id))]);
    expect(results.map(x => x.code).sort()).toEqual([0, 1]);
    expect(results.find(x => x.code !== 0)!.err).toContain('cycle');
    expect(store.get(root, a.id).dependencies.length + store.get(root, b.id).dependencies.length).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('opposite CLI and bridge links serialize without a cycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-deps-http-'));
  store.init(root);
  const a = store.create(root, { title: 'A' });
  const b = store.create(root, { title: 'B' });
  const ui = join(root, 'ui.html');
  writeFileSync(ui, '<p>ui</p>');
  const bridge = startBridge(root, 0, ui, () => {});
  try {
    const hash = store.hashItem(root, b.id);
    const process = cli(root, 'dependency-add', a.id, b.id);
    const response = fetch(`http://127.0.0.1:${bridge.port}/api/items/${b.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: b.revision, hash, changes: { dependencies: [a.id] } }),
    });
    const [command, patch] = await Promise.all([output(process), response]);
    expect((command.code === 0 ? 1 : 0) + (patch.status === 200 ? 1 : 0)).toBe(1);
    expect([200, 400]).toContain(patch.status);
    expect(store.get(root, a.id).dependencies.length + store.get(root, b.id).dependencies.length).toBe(1);
  } finally { bridge.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('ready respects final column, archived and missing links; blocked cards can be claimed and moved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-deps-ready-'));
  try {
    store.init(root);
    const path = store.boardPath(root);
    const board = JSON.parse(readFileSync(path, 'utf8'));
    board.columns.push({ id: 'released', name: 'Released' });
    writeFileSync(path, JSON.stringify(board));
    const blocker = store.create(root, { title: 'Blocker' });
    const blocked = store.create(root, { title: 'Blocked' });
    const archived = store.create(root, { title: 'Archived', archived: true });
    const finished = store.create(root, { title: 'Finished', status: 'released' });
    const missing = store.create(root, { title: 'Missing' });
    const ready = store.create(root, { title: 'Ready' });
    for (const dep of [archived, finished, missing]) store.changeDependency(root, ready.id, dep.id, null, true);
    store.changeDependency(root, blocked.id, blocker.id, null, true);
    unlinkSync(store.itemPath(root, missing.id));
    const readReady = async () => JSON.parse((await output(cli(root, 'ready'))).out).map((x: any) => x.id);
    const ids = await readReady();
    expect(ids).toContain(ready.id);
    expect(ids).not.toContain(blocked.id);
    expect(ids).not.toContain(archived.id);
    expect(ids).not.toContain(finished.id);
    expect((await output(cli(root, 'claim', blocked.id, 'agent'))).code).toBe(0);
    expect((await output(cli(root, 'move', blocked.id, 'in-progress'))).code).toBe(0);
    expect((await readReady())).not.toContain(blocked.id);
    store.update(root, blocker.id, null, { status: 'released' });
    expect(await readReady()).toContain(blocked.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
