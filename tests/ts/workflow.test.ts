import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import { BoardError, Conflict } from '../../scripts/lib/types';

setDefaultTimeout(60000);

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-flow-'));
  dirs.push(root);
  store.init(root);
  return root;
}
const spawn = (root: string, ...args: string[]) => Bun.spawn(['bun', CLI, '--root', root, '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
async function run(root: string, ...args: string[]) {
  const p = spawn(root, ...args);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe('store lifecycle', () => {
  test('create -> update -> stale revision conflicts -> claim -> contested claim conflicts', () => {
    const root = project();
    const item = store.create(root, { title: 'Task' });
    expect(item.revision).toBe(1);
    const updated = store.update(root, item.id, 1, { status: 'in-progress' });
    expect(updated).toMatchObject({ revision: 2, status: 'in-progress' });
    expect(() => store.update(root, item.id, 1, { title: 'stale' })).toThrow(Conflict);
    const claimed = store.update(root, item.id, null, { assignee: 'alpha' }, { claim: true });
    expect(claimed.assignee).toBe('alpha');
    expect(() => store.update(root, item.id, null, { assignee: 'beta' }, { claim: true })).toThrow(Conflict);
    expect(store.update(root, item.id, null, { assignee: 'alpha' }, { claim: true }).assignee).toBe('alpha');
    expect(store.get(root, item.id).assignee).toBe('alpha');
  });

  test('invalid inputs are rejected with BoardError and leave no item behind', () => {
    const root = project();
    const bad: any[] = [
      { title: '' }, { title: 'x'.repeat(301) }, { title: 'x', status: 'nope' }, { title: 'x', priority: 'huge' },
      { title: 'x', labels: ['a', 'a'] }, { title: 'x', labels: 'a' }, { title: 'x', acceptanceCriteria: [{ text: '', done: false }] },
      { title: 'x', acceptanceCriteria: [{ text: 'a' }] }, { title: 'x', assignee: 'a'.repeat(121) }, { title: 'x', archived: 'yes' },
      { title: 'x', unknownField: 1 }, {}, { title: 'x', description: 'd'.repeat(100001) },
    ];
    for (const values of bad) expect(() => store.create(root, values), JSON.stringify(values).slice(0, 60)).toThrow(BoardError);
    expect(readdirSync(join(root, '.agentboard', 'items'))).toEqual([]);
    const item = store.create(root, { title: 'ok' });
    expect(() => store.update(root, 'bad-id', null, { title: 'x' })).toThrow('Invalid item ID');
    expect(() => store.update(root, 'AB-000000000000', null, { title: 'x' })).toThrow();
    expect(() => store.update(root, item.id, null, { status: 'nope' })).toThrow(BoardError);
    expect(store.get(root, item.id).revision).toBe(1);
  });
});

describe('concurrent CLI processes', () => {
  test('two concurrent claims: exactly one wins (exit codes [0, 2]), repeated', async () => {
    const root = project();
    for (let round = 0; round < 4; round++) {
      const id = JSON.parse((await run(root, 'create', `Claim ${round}`)).out).id;
      const results = await Promise.all([run(root, 'claim', id, 'alice'), run(root, 'claim', id, 'bob')]);
      expect(results.map(r => r.code).sort(), results.map(r => r.err).join('|')).toEqual([0, 2]);
      const winner = JSON.parse(results.find(r => r.code === 0)!.out).assignee;
      expect(store.get(root, id).assignee).toBe(winner);
    }
  });

  test('10 concurrent creates give 10 valid, distinct items', async () => {
    const root = project();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => run(root, 'create', `Item ${i}`)));
    expect(results.map(r => r.code)).toEqual(Array(10).fill(0));
    const ids = results.map(r => JSON.parse(r.out).id);
    expect(new Set(ids).size).toBe(10);
    const snap = store.snapshot(root);   // validates every file on disk
    expect(snap.items.map(i => i.id).sort()).toEqual([...ids].sort());
    expect(snap.items.map(i => i.title).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `Item ${i}`).sort());
  });
});
