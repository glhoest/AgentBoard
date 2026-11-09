// Upgrade-on-read: older files are rewritten in the current format on first read (CLI, store and
// bridge), under the lock, exactly once even with concurrent readers; newer files are rejected.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startBridge } from '../../scripts/lib/serve';
import { setup } from '../../scripts/lib/setup';
import * as store from '../../scripts/lib/store';

setDefaultTimeout(60000);

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
const LEGACY = join(import.meta.dir, 'fixtures', 'v1-board');
const UPGRADED = join(import.meta.dir, 'fixtures', 'format', 'legacy-upgraded');
const READER = join(import.meta.dir, 'fixtures', 'upgrade-reader.ts');
const HOLD = join(import.meta.dir, 'lock-fixtures', 'hold.ts');
const A = 'AB-0000000000A1';
const IDS = [A, 'AB-0000000000B2', 'AB-0000000000C3'];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A temporary project holding a copy of the v1 legacy board. */
function legacy(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-upgrade-'));
  dirs.push(root);
  cpSync(LEGACY, join(root, '.agentboard'), { recursive: true });
  return root;
}
const file = (root: string, id: string) => readFileSync(store.itemPath(root, id), 'utf8');
const boardText = (root: string) => readFileSync(store.boardPath(root), 'utf8');
const expected = (path: string) => readFileSync(join(UPGRADED, path), 'utf8');
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

async function run(root: string, ...args: string[]) {
  const p = Bun.spawn(['bun', CLI, '--root', root, '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

function assertFullyUpgraded(root: string) {
  expect(boardText(root)).toBe(expected('board.json'));
  for (const id of IDS) expect(file(root, id)).toBe(expected(`items/${id}.json`));
}

describe('upgrade-on-read in the store and CLI', () => {
  test('show upgrades board.json and the one card it reads; list upgrades the rest', async () => {
    const root = legacy();
    const shown = await run(root, 'show', A);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ version: '1.1.0', revision: 3, thread: [], feature: null });
    expect(boardText(root)).toBe(expected('board.json'));
    expect(file(root, A)).toBe(expected(`items/${A}.json`));
    expect(file(root, IDS[1])).toBe(readFileSync(join(LEGACY, 'items', `${IDS[1]}.json`), 'utf8'));
    expect((await run(root, 'list', '--all')).code).toBe(0);
    assertFullyUpgraded(root);
  });

  test('an edit on a v1 card writes the current format and bumps the revision once', async () => {
    const root = legacy();
    const edited = await run(root, 'edit', A, '--revision', '3', '--title', 'Edited');
    expect(edited.code).toBe(0);
    const disk = JSON.parse(file(root, A));
    expect(disk).toMatchObject({ version: '1.1.0', revision: 4, title: 'Edited', thread: [] });
  });

  test('a pure format upgrade keeps revision and updatedAt, so --revision from an earlier read still applies', async () => {
    const root = legacy();
    const before = JSON.parse(file(root, A));
    store.get(root, A);   // upgrades
    const after = JSON.parse(file(root, A));
    expect([after.revision, after.updatedAt]).toEqual([before.revision, before.updatedAt]);
    expect(store.update(root, A, before.revision, { notes: 'still current' }).revision).toBe(before.revision + 1);
  });

  test('persist: false upgrades in memory only; setup checks an old board without rewriting it', () => {
    const root = legacy();
    const bytes = boardText(root);
    const snap = store.snapshot(root, { persist: false });
    expect(snap.config.version).toBe('1.1.0');
    expect(snap.items.every(item => item.version === '1.1.0')).toBe(true);
    expect(boardText(root)).toBe(bytes);
    expect(file(root, A)).toBe(readFileSync(join(LEGACY, 'items', `${A}.json`), 'utf8'));
    setup(root, resolve(import.meta.dir, '../..'));
    expect(boardText(root)).toBe(bytes);
  });

  test('an invalid old file is reported and never rewritten', async () => {
    const root = legacy();
    const path = store.itemPath(root, A);
    const broken = file(root, A).replace('"in-progress"', '"nowhere"');
    writeFileSync(path, broken);
    const shown = await run(root, 'show', A);
    expect(shown.code).toBe(1);
    expect(shown.err).toContain('Error: Unknown status');
    expect(file(root, A)).toBe(broken);
  });

  test('an old board.json with unknown keys fails loudly and stays untouched', async () => {
    const root = legacy();
    const text = boardText(root).replace('"name": "legacy",', '"name": "legacy",\n  "custom": true,');
    writeFileSync(store.boardPath(root), text);
    const listed = await run(root, 'list');
    expect(listed.code).toBe(1);
    expect(listed.err).toContain('Unknown keys in board.json: custom');
    expect(boardText(root)).toBe(text);
  });

  test('files from a newer AgentBoard are rejected loudly and left alone (CLI exit 1, bridge 400)', async () => {
    const root = legacy();
    store.snapshot(root);
    const newer = file(root, A).replace('"version": "1.1.0"', '"version": "1.2.0"');
    writeFileSync(store.itemPath(root, A), newer);
    for (const args of [['show', A], ['list'], ['edit', A, '--title', 'x'], ['ask', A, 'q?']]) {
      const result = await run(root, ...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err).toContain('Card format 1.2.0 was written by a newer AgentBoard (this copy supports up to 1.1.0); update this copy');
    }
    expect(file(root, A)).toBe(newer);

    writeFileSync(store.boardPath(root), boardText(root).replace('"version": "1.1.0"', '"version": "2.0.0"'));
    const shown = await run(root, 'show', IDS[1]);
    expect(shown.code).toBe(1);
    expect(shown.err).toContain('board.json format 2.0.0 was written by a newer AgentBoard');

    const ui = join(root, 'ui.html');
    writeFileSync(ui, '<p>ui</p>');
    const bridge = startBridge(root, 0, ui, () => {});
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}/api/board`, { headers: { Authorization: `Bearer ${bridge.token}` } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain('newer AgentBoard');
    } finally {
      bridge.stop();
    }
  });

  test('reads of current files do not take the lock; reads that must upgrade wait for it', async () => {
    const root = legacy();
    store.get(root, A);   // A is current now, B2 is still v1
    const holder = Bun.spawn(['bun', HOLD, root], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = holder.stdout.getReader();
      let seen = '';
      while (!seen.includes('locked')) {
        const part = await reader.read();
        if (part.done) throw new Error('holder exited early');
        seen += new TextDecoder().decode(part.value);
      }
      const current = await run(root, '--quiet', 'show', A);
      expect(current.code).toBe(0);

      const waiting = Bun.spawn(['bun', CLI, '--root', root, '--quiet', 'show', IDS[1]], { stdout: 'pipe', stderr: 'pipe' });
      const early = await Promise.race([waiting.exited, Bun.sleep(1500).then(() => 'still waiting')]);
      expect(early).toBe('still waiting');
      expect(file(root, IDS[1])).toBe(readFileSync(join(LEGACY, 'items', `${IDS[1]}.json`), 'utf8'));
      holder.kill();
      expect(await waiting.exited).toBe(0);
      expect(file(root, IDS[1])).toBe(expected(`items/${IDS[1]}.json`));
    } finally {
      holder.kill();
    }
  });
});

describe('concurrent readers on an old board', () => {
  test('each file is upgraded exactly once; every reader succeeds', async () => {
    const root = legacy();
    const log = join(root, 'upgrades.log');
    writeFileSync(log, '');
    const readers = Array.from({ length: 8 }, (_, i) => Bun.spawn(
      ['bun', READER, root, log, ...(i % 2 ? ['get', A] : ['snapshot'])], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(readers.map(async p => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.map(r => r.code), results.map(r => r.err).join('|')).toEqual(Array(8).fill(0));
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ').slice(1).join(' ')).sort();
    expect(lines).toEqual([
      ...IDS.map(id => `${id}.json 1.0.0 1.1.0`),
      'board.json 1.0.0 1.1.0',
    ].sort());
    assertFullyUpgraded(root);
  });

  test('several concurrent CLI list/show/questions processes all succeed and leave valid current files', async () => {
    const root = legacy();
    const commands = [
      ...Array.from({ length: 4 }, () => ['list', '--all']),
      ...Array.from({ length: 3 }, () => ['show', A]),
      ['questions'], ['thread', IDS[2]],
    ];
    const results = await Promise.all(commands.map(args => run(root, ...args)));
    expect(results.map(r => r.code), results.map(r => r.err).join('|')).toEqual(Array(commands.length).fill(0));
    for (const result of results.slice(0, 4)) {
      expect(JSON.parse(result.out).map((item: any) => item.version)).toEqual(['1.1.0', '1.1.0', '1.1.0']);
    }
    assertFullyUpgraded(root);
    expect(readdirSync(join(root, '.agentboard', 'items')).sort()).toEqual(IDS.map(id => `${id}.json`));   // no temp files left
  });
});

describe('upgrade-on-read in the bridge', () => {
  test('GET /api/board returns upgraded cards with hashes of the upgraded bytes; a PATCH based on it succeeds', async () => {
    const root = legacy();
    const oldHash = sha(file(root, A));
    const ui = join(root, 'ui.html');
    writeFileSync(ui, '<p>ui</p>');
    const bridge = startBridge(root, 0, ui, () => {});
    const base = `http://127.0.0.1:${bridge.port}`;
    const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
    try {
      const snap = (await (await fetch(`${base}/api/board`, { headers })).json()) as any;
      expect(snap.config.version).toBe('1.1.0');
      expect(snap.config.columns.map((c: any) => c.id)).toContain('needs-grilling');
      expect(snap.items.map((item: any) => [item.version, item.thread, item.feature])).toEqual(IDS.map(() => ['1.1.0', [], null]));
      assertFullyUpgraded(root);
      for (const id of IDS) expect(snap.hashes[id]).toBe(sha(file(root, id)));
      expect(snap.hashes[A]).not.toBe(oldHash);

      // A client that read the old bytes (before the upgrade) holds a stale hash: 409, then it reloads.
      const stale = await fetch(`${base}/api/items/${A}`, { method: 'PATCH', headers, body: JSON.stringify({ revision: 3, hash: oldHash, changes: { notes: 'x' } }) });
      expect(stale.status).toBe(409);
      // A client that read after the upgrade is not affected by it.
      const fresh = await fetch(`${base}/api/items/${A}`, { method: 'PATCH', headers, body: JSON.stringify({ revision: 3, hash: snap.hashes[A], changes: { notes: 'after upgrade' } }) });
      expect(fresh.status).toBe(200);
      expect(await fresh.json()).toMatchObject({ revision: 4, notes: 'after upgrade', version: '1.1.0' });
    } finally {
      bridge.stop();
    }
  });
});

describe('board.json 1.1.0 upgrade', () => {
  test('the column is inserted once and not re-added after the user removes it', async () => {
    const root = legacy();
    store.config(root);
    const upgraded = JSON.parse(boardText(root));
    expect(upgraded.columns.map((c: any) => c.id)).toEqual(['backlog', 'needs-grilling', 'todo', 'in-progress', 'blocked', 'done']);
    upgraded.columns = upgraded.columns.filter((c: any) => c.id !== 'needs-grilling');
    writeFileSync(store.boardPath(root), JSON.stringify(upgraded, null, 2) + '\n');
    const text = boardText(root);
    expect((await run(root, 'list')).code).toBe(0);
    expect(boardText(root)).toBe(text);
    const grill = await run(root, 'grill');
    expect(grill.code).toBe(1);
    expect(grill.err).toContain('This board has no "needs-grilling" column');
  });

  test('a v1 board without backlog gets the column first; one that has it keeps it', () => {
    const root = legacy();
    const v1 = JSON.parse(boardText(root));
    v1.columns = [{ id: 'todo', name: 'To do' }, { id: 'in-progress', name: 'In progress' }, { id: 'done', name: 'Done' }];
    writeFileSync(store.boardPath(root), JSON.stringify(v1, null, 2) + '\n');
    for (const id of IDS) writeFileSync(store.itemPath(root, id), file(root, id).replace(/"status": "(backlog|blocked)"/, '"status": "todo"'));
    expect(store.config(root).columns.map(c => c.id)).toEqual(['needs-grilling', 'todo', 'in-progress', 'done']);

    const other = legacy();
    const existing = JSON.parse(boardText(other));
    existing.columns.push({ id: 'needs-grilling', name: 'Grill me' });
    writeFileSync(store.boardPath(other), JSON.stringify(existing, null, 2) + '\n');
    const columns = store.config(other).columns;
    expect(columns.filter(c => c.id === 'needs-grilling')).toEqual([{ id: 'needs-grilling', name: 'Grill me' }]);
    expect(columns.at(-1)!.id).toBe('needs-grilling');
  });
});
