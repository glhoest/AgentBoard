import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../scripts/lib/store';
import { Conflict } from '../../scripts/lib/types';

test('features validate, link, count, archive and preserve dangling links', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-feature-'));
  try {
    store.init(root);
    expect(existsSync(join(root, '.agentboard', 'features'))).toBe(false);
    expect(() => store.createFeature(root, { title: '' })).toThrow();
    expect(() => store.createFeature(root, { title: 'x', status: 'bad' })).toThrow();
    expect(() => store.createFeature(root, { title: 'x', description: 'x'.repeat(100001) })).toThrow();
    const feature = store.createFeature(root, { title: 'Feature' });
    expect(Object.keys(feature)).toEqual(['version', 'id', 'revision', 'title', 'status', 'description', 'createdAt', 'updatedAt', 'archived']);
    const card = store.create(root, { title: 'Card', feature: feature.id, status: 'done' });
    store.create(root, { title: 'Archived', feature: feature.id, archived: true });
    const snap = store.snapshot(root);
    expect(store.featureSummary(feature, snap.items, snap.config.columns).progress).toEqual({ done: 1, total: 1 });
    expect(() => store.updateFeature(root, feature.id, 1, { title: 'stale' })).toThrow(Conflict);
    const hash = store.hashFeature(root, feature.id);
    const path = store.featurePath(root, feature.id);
    writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(() => store.updateFeature(root, feature.id, 1, { title: 'stale' }, { expectedHash: hash })).toThrow(Conflict);
    store.updateFeature(root, feature.id, 2, { archived: true });
    expect(store.snapshot(root).items.find(item => item.id === card.id)?.feature).toBe(feature.id);
    expect(() => store.create(root, { title: 'bad', feature: feature.id })).toThrow('archived');
    expect(store.update(root, card.id, null, { feature: null }).feature).toBeNull();
    expect(() => store.create(root, { title: 'bad', feature: 'FT-000000000000' })).toThrow('does not exist');
    const newer = readFileSync(path, 'utf8').replace('1.0.0', '1.0.1');
    writeFileSync(path, newer);
    expect(() => store.snapshot(root)).toThrow('newer AgentBoard');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { test, expect } from 'bun:test';
import { parseArgs } from '../../scripts/lib/args';

test('feature command arguments and card link options parse', () => {
  for (const args of [
    ['feature-create', 'F', '--status', 'active'], ['feature-edit', 'FT-000000000001', '--archive'],
    ['feature-move', 'FT-000000000001', 'done'], ['feature-show', 'FT-000000000001'],
    ['features', '--include-archived'], ['create', 'C', '--feature', 'FT-000000000001'],
    ['edit', 'AB-000000000001', '--clear-feature'], ['list', '--feature', 'FT-000000000001'],
  ]) expect(parseArgs(args).kind).toBe('ok');
});

import { startBridge } from '../../scripts/lib/serve';

test('feature bridge creates, links and checks hashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-feature-http-'));
  store.init(root);
  const ui = join(root, 'ui.html');
  writeFileSync(ui, 'ui');
  const bridge = startBridge(root, 0, ui, () => {});
  const base = `http://127.0.0.1:${bridge.port}`;
  const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
  try {
    const created = await fetch(`${base}/api/features`, { method: 'POST', headers, body: JSON.stringify({ title: 'F' }) });
    expect(created.status).toBe(201);
    const feature = await created.json() as any;
    const item = await fetch(`${base}/api/items`, { method: 'POST', headers, body: JSON.stringify({ title: 'C', feature: feature.id }) });
    expect(item.status).toBe(201);
    const snap = await (await fetch(`${base}/api/board`, { headers })).json() as any;
    expect(snap.features[0].id).toBe(feature.id);
    expect(snap.hashes[feature.id]).toBe(store.hashFeature(root, feature.id));
    const patch = (hash: string) => fetch(`${base}/api/features/${feature.id}`, { method: 'PATCH', headers,
      body: JSON.stringify({ revision: 1, hash, changes: { archived: true } }) });
    expect((await patch('0'.repeat(64))).status).toBe(409);
    expect((await patch(snap.hashes[feature.id])).status).toBe(200);
    expect((await fetch(`${base}/api/items`, { method: 'POST', headers, body: JSON.stringify({ title: 'C', feature: feature.id }) })).status).toBe(400);
  } finally {
    bridge.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
function cli(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', CLI, '--root', root, '--json', ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
function project() {
  const root = mkdtempSync(join(tmpdir(), 'ab-feature-case-'));
  store.init(root);
  return root;
}

test('feature validation boundaries and strict structure', () => {
  const root = project();
  try {
    for (const values of [{ title: '' }, { title: 'x'.repeat(301) }, { title: 'x', status: 'missing' },
      { title: 'x', description: 'd'.repeat(100001) }]) expect(() => store.createFeature(root, values)).toThrow();
    const feature = store.createFeature(root, { title: 'x'.repeat(300), description: 'd'.repeat(100000) });
    const cfg = store.config(root);
    for (const changes of [{ revision: 0 }, { id: 'FT-bad' }, { createdAt: 'today' }, { updatedAt: 'today' }, { extra: 1 }]) {
      expect(() => store.validateFeature({ ...feature, ...changes }, cfg)).toThrow();
    }
    const { title, ...missing } = feature;
    expect(() => store.validateFeature(missing, cfg)).toThrow();
    expect(store.validateFeature({ archived: feature.archived, ...feature }, cfg)).toEqual(feature);
    const boardPath = join(root, '.agentboard', 'board.json');
    writeFileSync(boardPath, JSON.stringify({ ...cfg, featureColumns: [{ id: 'custom', name: 'Custom' }] }));
    expect(store.createFeature(root, { title: 'custom' }).status).toBe('custom');
    expect(() => store.createFeature(root, { title: 'bad', status: 'planned' })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid feature files fail snapshot without rewriting', () => {
  const root = project();
  try {
    const f = store.createFeature(root, { title: 'F' });
    const path = store.featurePath(root, f.id);
    for (const value of [{ ...f, id: 'FT-000000000000' }, { ...f, revision: 0 }, { ...f, version: '1.0.1' }]) {
      const bytes = JSON.stringify(value);
      writeFileSync(path, bytes);
      expect(() => store.snapshot(root)).toThrow(value.version === '1.0.1' ? 'newer AgentBoard' : undefined);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('progress counts only live cards and feature-show marks archived cards', () => {
  const root = project();
  try {
    const f = store.createFeature(root, { title: 'F' });
    expect(store.featureSummary(f, [], store.config(root).columns).progress).toEqual({ done: 0, total: 0 });
    store.create(root, { title: 'Done', status: 'done', feature: f.id });
    store.create(root, { title: 'Todo', status: 'todo', feature: f.id });
    const archived = store.create(root, { title: 'Archived', status: 'done', feature: f.id, archived: true });
    const show = JSON.parse(cli(root, 'feature-show', f.id).out);
    expect(show.progress).toEqual({ done: 1, total: 2 });
    expect(show.counts).toMatchObject({ done: 1, todo: 1, backlog: 0 });
    expect(show.cards.find((c: any) => c.id === archived.id).archived).toBe(true);
    store.updateFeature(root, f.id, null, { archived: true });
    expect(JSON.parse(cli(root, 'feature-show', f.id).out).progress).toEqual({ done: 1, total: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing and archived feature links remain editable and appear dangling', () => {
  const root = project();
  try {
    const f = store.createFeature(root, { title: 'F' });
    const card = store.create(root, { title: 'Card', feature: f.id });
    store.updateFeature(root, f.id, 1, { archived: true });
    expect(JSON.parse(cli(root, 'features').out).dangling).toContain(card.id);
    expect(() => store.create(root, { title: 'No', feature: f.id })).toThrow('archived');
    rmSync(store.featurePath(root, f.id));
    expect(store.snapshot(root).items[0].feature).toBe(f.id);
    expect(JSON.parse(cli(root, 'features').out).dangling).toContain(card.id);
    expect(store.update(root, card.id, null, { title: 'Edited' }).feature).toBe(f.id);
    expect(store.update(root, card.id, null, { feature: null }).feature).toBeNull();
    expect(() => store.update(root, card.id, null, { feature: f.id })).toThrow('does not exist');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feature operations preserve unrelated cards and do not leave temp files', () => {
  const root = project();
  try {
    const card = store.create(root, { title: 'Card' });
    const path = store.itemPath(root, card.id);
    const before = readFileSync(path, 'utf8');
    expect(existsSync(join(root, '.agentboard', 'features'))).toBe(false);
    const f = store.createFeature(root, { title: 'F' });
    store.updateFeature(root, f.id, 1, { title: 'F2' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(store.update(root, card.id, 1, { feature: f.id }).version).toBe('1.1.0');
    expect(store.getFeature(root, f.id).title).toBe('F2');
    expect(readdirSync(join(root, '.agentboard', 'features'))).toEqual([`${f.id}.json`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent feature creates and revision edits serialize', async () => {
  const root = project();
  const run = async (...args: string[]) => {
    const p = Bun.spawn(['bun', CLI, '--root', root, '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => run('feature-create', `F ${i}`)));
    expect(results.map(r => r.code)).toEqual(Array(10).fill(0));
    const ids = results.map(r => JSON.parse(r.out).id);
    expect(new Set(ids).size).toBe(10);
    expect(store.snapshot(root).features.map(f => f.id)).toEqual([...ids].sort());
    const edits = await Promise.all([run('feature-edit', ids[0], '--revision', '1', '--title', 'A'), run('feature-edit', ids[0], '--revision', '1', '--title', 'B')]);
    expect(edits.map(r => r.code).sort()).toEqual([0, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('CLI feature lifecycle, filters and link errors', () => {
  const root = project();
  try {
    const feature = JSON.parse(cli(root, 'feature-create', 'Release').out);
    const card = JSON.parse(cli(root, 'create', 'Linked', '--feature', feature.id).out);
    expect(JSON.parse(cli(root, 'list', '--feature', feature.id).out).map((i: any) => i.id)).toEqual([card.id]);
    expect(cli(root, 'edit', card.id, '--feature', feature.id, '--clear-feature').code).toBe(2);
    expect(cli(root, 'feature-edit', feature.id, '--revision', '2', '--title', 'stale').code).toBe(2);
    expect(cli(root, 'feature-move', feature.id, 'active').code).toBe(0);
    expect(cli(root, 'feature-edit', feature.id, '--archive').code).toBe(0);
    expect(JSON.parse(cli(root, 'features').out).features).toEqual([]);
    expect(JSON.parse(cli(root, 'features', '--include-archived').out).features).toHaveLength(1);
    const rejected = cli(root, 'create', 'No', '--feature', feature.id);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain('archived');
    expect(cli(root, 'feature-edit', feature.id, '--unarchive').code).toBe(0);
    expect(cli(root, 'edit', card.id, '--clear-feature').code).toBe(0);
    const unknown = cli(root, 'edit', card.id, '--feature', 'FT-000000000000');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('does not exist');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feature commands retain the open question notice without changing stdout', () => {
  const root = project();
  try {
    const card = store.create(root, { title: 'Question' });
    expect(cli(root, 'ask', card.id, 'Why?').code).toBe(0);
    const result = cli(root, 'feature-create', 'Feature');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).title).toBe('Feature');
    expect(result.err).toContain('open question');
    const quiet = cli(root, '--quiet', 'features');
    expect(quiet.err).toBe('');
    expect(JSON.parse(quiet.out).features).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rename retry is bounded and preserves the original error', () => {
  const first = Object.assign(new Error('busy'), { code: 'EPERM' });
  let calls = 0;
  let sleeps = 0;
  store.renameWithRetry('a', 'b', 'win32', () => {
    if (++calls < 3) throw first;
  }, () => { sleeps++; });
  expect(calls).toBe(3);
  expect(sleeps).toBe(2);
  calls = 0;
  expect(() => store.renameWithRetry('a', 'b', 'win32', () => {
    calls++;
    throw calls === 1 ? first : Object.assign(new Error('again'), { code: 'EBUSY' });
  }, () => {})).toThrow(first);
  expect(calls).toBe(10);
  calls = 0;
  expect(() => store.renameWithRetry('a', 'b', 'linux', () => { calls++; throw first; }, () => {})).toThrow(first);
  expect(calls).toBe(1);
});

test('feature errors, dangling cards, filenames, and removed statuses are visible', () => {
  const root = project();
  try {
    const empty = cli(root, 'feature-create', '');
    expect(empty.code).toBe(1);
    expect(empty.err.trim()).toBe('Error: Title must be 1–300 characters');
    const f = store.createFeature(root, { title: 'F' });
    const card = store.create(root, { title: 'live', feature: f.id });
    const archived = store.create(root, { title: 'archived', feature: f.id, archived: true });
    store.updateFeature(root, f.id, 1, { archived: true });
    expect(JSON.parse(cli(root, 'features').out).dangling).toEqual([card.id]);
    expect(JSON.parse(cli(root, 'list').out).find((x: any) => x.id === card.id).feature).toBe(f.id);
    expect(JSON.parse(cli(root, 'show', card.id).out).feature).toBe(f.id);
    expect(JSON.parse(cli(root, 'features').out).dangling).not.toContain(archived.id);
    const dir = join(root, '.agentboard', 'features');
    writeFileSync(join(dir, '.tmp-leftover.json'), 'incomplete');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(store.snapshot(root).features).toHaveLength(1);
    writeFileSync(join(dir, 'stray.json'), '{}');
    expect(() => store.snapshot(root)).toThrow('Invalid feature filename: stray.json');
    rmSync(join(dir, 'stray.json'));
    const path = store.featurePath(root, f.id);
    const bytes = readFileSync(path, 'utf8');
    for (const value of ['[]', 'null', '"text"']) {
      writeFileSync(path, value);
      expect(() => store.snapshot(root)).toThrow('Invalid feature file');
    }
    writeFileSync(path, bytes);
    const cfgPath = join(root, '.agentboard', 'board.json');
    const cfg = store.config(root);
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, featureColumns: [{ id: 'other', name: 'Other' }] }));
    expect(() => store.snapshot(root)).toThrow(`Feature ${f.id} has unknown status: planned`);
    expect(cli(root, 'features').err).toContain(`Feature ${f.id} has unknown status: planned`);
    expect(cli(root, 'feature-move', f.id, 'other').err).toContain(`Feature ${f.id} has unknown status: planned`);
    expect(cli(root, 'feature-edit', f.id, '--archive', '--unarchive').code).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feature CLI rejects conflicting and empty edits and retries ID collisions', () => {
  const root = project();
  const original = store.seams.randomHex;
  try {
    const f = store.createFeature(root, { title: 'F' });
    expect(cli(root, 'feature-edit', f.id, '--archive', '--unarchive').code).toBe(1);
    const empty = cli(root, 'feature-edit', f.id);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain('Invalid or empty feature changes');
    expect(cli(root, 'feature-move', f.id).code).toBe(2);
    let calls = 0;
    store.seams.randomHex = () => ++calls === 1 ? f.id.slice(3) : 'ABCDEF123456';
    expect(store.createFeature(root, { title: 'second' }).id).toBe('FT-ABCDEF123456');
    expect(calls).toBe(2);
  } finally { store.seams.randomHex = original; rmSync(root, { recursive: true, force: true }); }
});

test('feature HTTP validation and dangling links', async () => {
  const root = project();
  const ui = join(root, 'ui.html');
  writeFileSync(ui, 'ui');
  const bridge = startBridge(root, 0, ui, () => {});
  const base = `http://127.0.0.1:${bridge.port}`;
  const auth = { Authorization: `Bearer ${bridge.token}` };
  const headers = { ...auth, 'Content-Type': 'application/json' };
  try {
    expect((await (await fetch(`${base}/api/board`, { headers: auth })).json() as any).features).toEqual([]);
    for (const [method, path] of [['POST', '/api/features'], ['PATCH', '/api/features/FT-000000000000']]) {
      expect((await fetch(base + path, { method, headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' })).status).toBe(403);
      expect((await fetch(base + path, { method, headers: { ...headers, Host: 'evil.example' }, body: '{}' })).status).toBe(403);
      expect((await fetch(base + path, { method, headers })).status).toBe(400);
      expect((await fetch(base + path, { method, headers: auth, body: '{}' })).status).toBe(400);
      expect((await fetch(base + path, { method, headers, body: 'x'.repeat(1048577) })).status).toBe(400);
    }
    const invalid = await fetch(`${base}/api/features`, { method: 'POST', headers, body: '{"title":""}' });
    expect(await invalid.json()).toMatchObject({ error: 'Title must be 1–300 characters' });
    const missing = await fetch(`${base}/api/features/FT-000000000000`, { method: 'PATCH', headers,
      body: JSON.stringify({ revision: 1, hash: '0'.repeat(64), changes: { title: 'x' } }) });
    expect(missing.status).toBe(400);
    for (const body of [{ changes: {} }, { revision: 1, changes: {} }, { hash: '0'.repeat(64), changes: {} }]) {
      expect((await fetch(`${base}/api/features/FT-000000000000`, { method: 'PATCH', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    const f = store.createFeature(root, { title: 'F' });
    const card = store.create(root, { title: 'C', feature: f.id });
    store.updateFeature(root, f.id, 1, { archived: true });
    expect((await (await fetch(`${base}/api/board`, { headers: auth })).json() as any).items[0].feature).toBe(f.id);
    rmSync(store.featurePath(root, f.id));
    expect((await (await fetch(`${base}/api/board`, { headers: auth })).json() as any).items[0].id).toBe(card.id);
  } finally { bridge.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('lock-free readers see complete card and feature files during writes', async () => {
  const root = project();
  try {
    const feature = store.createFeature(root, { title: 'F' });
    const card = store.create(root, { title: 'C', feature: feature.id });
    const modulePath = join(import.meta.dir, '../../scripts/lib/store.ts');
    const code = `import * as store from ${JSON.stringify(modulePath)};
      const [root, card, feature] = process.argv.slice(1);
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        store.update(root, card, null, { title: String(Date.now()) });
        store.updateFeature(root, feature, null, { title: String(Date.now()) });
      }`;
    const writer = Bun.spawn(['bun', '-e', code, root, card.id, feature.id], { stdout: 'pipe', stderr: 'pipe' });
    let reads = 0;
    while (writer.exitCode === null) {
      const cfg = store.config(root, { persist: false });
      store.validate(JSON.parse(readFileSync(store.itemPath(root, card.id), 'utf8')), cfg);
      store.validateFeature(JSON.parse(readFileSync(store.featurePath(root, feature.id), 'utf8')), cfg);
      reads++;
      await Bun.sleep(0);
    }
    const stderr = await new Response(writer.stderr).text();
    expect({ code: await writer.exited, stderr }).toEqual({ code: 0, stderr: '' });
    expect(reads).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('feature flag spellings parse', () => {
  for (const args of [
    ['feature-create', 'F', '--sta=active', '--desc=text'],
    ['feature-edit', 'FT-000000000001', '--rev=1', '--tit=New', '--sta=done', '--desc=text', '--unarchive'],
    ['feature-move', 'FT-000000000001', 'done', '--rev=1'],
    ['features', '--include-arch'],
    ['create', 'C', '--fea=FT-000000000001'],
    ['edit', 'AB-000000000001', '--clear-fea'],
    ['list', '--fea=FT-000000000001'],
  ]) expect(parseArgs(args).kind).toBe('ok');
});
