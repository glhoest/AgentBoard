import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startBridge } from '../../scripts/lib/serve';
import * as store from '../../scripts/lib/store';

const CLI = join(import.meta.dir, '../../scripts/agentboard.ts');
let dir: string, bridge: ReturnType<typeof startBridge>, base: string;
const auth = () => ({ Authorization: `Bearer ${bridge.token}` });
const json = () => ({ ...auth(), 'Content-Type': 'application/json' });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-bridge-'));
  const ui = join(dir, 'board.html');
  writeFileSync(ui, '<p>ui</p>');
  store.init(dir);
  bridge = startBridge(dir, 0, ui, () => {});
  base = `http://127.0.0.1:${bridge.port}`;
});
afterAll(() => { bridge.stop(); rmSync(dir, { recursive: true, force: true }); });

const board = async () => (await (await fetch(`${base}/api/board`, { headers: auth() })).json()) as any;
const create = async (title: string) => (await (await fetch(`${base}/api/items`, { method: 'POST', headers: json(), body: JSON.stringify({ title }) })).json()) as any;
const patch = (id: string, body: unknown) => fetch(`${base}/api/items/${id}`, { method: 'PATCH', headers: json(), body: typeof body === 'string' ? body : JSON.stringify(body) });

function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: bridge.port });
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries({ Connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
  });
}

describe('bridge HTTP', () => {
  test('403 without a token, with a wrong token, and with a bad Host', async () => {
    expect((await fetch(`${base}/api/board`)).status).toBe(403);
    expect((await fetch(`${base}/api/board`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(403);
    expect(await rawGet('/api/board', { Host: 'evil.example', ...auth() })).toBe(403);
    expect(await rawGet('/api/board', { Host: `127.0.0.1:${bridge.port}`, ...auth() })).toBe(200);
  });

  test('POST 201, PATCH 200', async () => {
    const res = await fetch(`${base}/api/items`, { method: 'POST', headers: json(), body: JSON.stringify({ title: 'Created' }) });
    expect(res.status).toBe(201);
    const item = (await res.json()) as any;
    expect(item).toMatchObject({ title: 'Created', revision: 1, status: 'backlog', priority: 'medium' });
    const snap = await board();
    const ok = await patch(item.id, { revision: 1, hash: snap.hashes[item.id], changes: { title: 'Renamed' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ title: 'Renamed', revision: 2 });
  });

  test('409 on a stale revision', async () => {
    const item = await create('Rev');
    const snap = await board();
    expect((await patch(item.id, { revision: 1, hash: snap.hashes[item.id], changes: { title: 'two' } })).status).toBe(200);
    const stale = await patch(item.id, { revision: 1, hash: snap.hashes[item.id], changes: { title: 'three' } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).code).toBe('conflict');
  });

  test('409 on a stale hash after a manual byte edit (revision unchanged)', async () => {
    const item = await create('Manual');
    const snap = await board();
    appendFileSync(store.itemPath(dir, item.id), ' ');   // trailing space: still valid JSON, same revision
    expect(store.get(dir, item.id).revision).toBe(1);
    const res = await patch(item.id, { revision: 1, hash: snap.hashes[item.id], changes: { title: 'lost?' } });
    expect(res.status).toBe(409);
    expect(store.get(dir, item.id).title).toBe('Manual');
  });

  test('400 on malformed bodies, 404 on unknown routes', async () => {
    const item = await create('Bad');
    expect((await patch(item.id, '{not json')).status).toBe(400);
    expect((await patch(item.id, { revision: 1, changes: {} })).status).toBe(400);
    expect((await patch(item.id, '[]')).status).toBe(400);
    expect((await fetch(`${base}/api/items`, { method: 'POST', headers: json(), body: JSON.stringify({ title: '' }) })).status).toBe(400);
    expect((await fetch(`${base}/api/items`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'text/plain' }, body: '{"title":"x"}' })).status).toBe(400);
    expect((await fetch(`${base}/api/nope`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/api/items/AB-000000000000`, { method: 'DELETE', headers: auth() })).status).toBe(404);
  });

  // The write fails inside the lock: on POSIX creating the temp file in a read-only directory
  // fails (EACCES), on Windows replacing a read-only file fails (EPERM). Root bypasses both.
  test.skipIf(process.getuid?.() === 0)('500 io_error (and CLI exit 1) when the write fails inside the lock', async () => {
    const item = await create('Read-only');
    const snap = await board();
    const file = store.itemPath(dir, item.id);
    const items = dirname(file);
    chmodSync(file, 0o444);
    chmodSync(items, 0o555);
    try {
      const res = await patch(item.id, { revision: 1, hash: snap.hashes[item.id], changes: { title: 'Lost' } });
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.code).toBe('io_error');
      expect(body.error).not.toContain('Cannot lock');

      const cli = Bun.spawnSync(['bun', CLI, '--root', dir, 'edit', item.id, '--title', 'Lost too']);
      expect(cli.exitCode).toBe(1);
      const stderr = cli.stderr.toString();
      expect(stderr).toMatch(/^Error: (EACCES|EPERM)/);
      expect(stderr).not.toContain('Cannot lock');
    } finally {
      chmodSync(items, 0o755);
      chmodSync(file, 0o644);
    }
    expect(store.get(dir, item.id)).toMatchObject({ title: 'Read-only', revision: 1 });
  });
});

describe('CLI and bridge on the same project', () => {
  test('a CLI edit shows up in the next snapshot; a PATCH from the older snapshot gets 409', async () => {
    const item = await create('Shared');
    const before = await board();
    const cli = Bun.spawnSync(['bun', CLI, '--root', dir, '--json', 'edit', item.id, '--title', 'From CLI']);
    expect(cli.exitCode).toBe(0);
    const after = await board();
    expect(after.items.find((i: any) => i.id === item.id)).toMatchObject({ title: 'From CLI', revision: 2 });
    expect(after.hashes[item.id]).not.toBe(before.hashes[item.id]);
    const stale = await patch(item.id, { revision: 1, hash: before.hashes[item.id], changes: { title: 'From stale UI' } });
    expect(stale.status).toBe(409);
    expect(store.get(dir, item.id).title).toBe('From CLI');
    const fresh = await patch(item.id, { revision: 2, hash: after.hashes[item.id], changes: { title: 'From fresh UI' } });
    expect(fresh.status).toBe(200);
  });
});

describe('thread routes', () => {
  const post = (id: string, body: unknown, headers = json()) =>
    fetch(`${base}/api/items/${id}/thread`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const patchEntry = (id: string, entryId: string, body: unknown) =>
    fetch(`${base}/api/items/${id}/thread/${entryId}`, { method: 'PATCH', headers: json(), body: JSON.stringify(body) });
  const current = async (id: string) => {
    const snap = await board();
    return { revision: snap.items.find((i: any) => i.id === id).revision, hash: snap.hashes[id] };
  };

  test('POST 201 and PATCH 200 return the updated item; threads arrive in GET /api/board', async () => {
    const item = await create('Thread');
    let res = await post(item.id, { ...(await current(item.id)), entry: { kind: 'question', body: 'Why?', author: 'ui' } });
    expect(res.status).toBe(201);
    let updated = (await res.json()) as any;
    expect(updated.revision).toBe(2);
    const q = updated.thread[0];
    expect(q).toMatchObject({ kind: 'question', body: 'Why?', author: 'ui', replyTo: null });
    res = await post(item.id, { ...(await current(item.id)), entry: { kind: 'answer', body: 'Because.', replyTo: q.id } });
    expect(res.status).toBe(201);
    res = await patchEntry(item.id, q.id, { ...(await current(item.id)), changes: { body: 'Why not?', author: null } });
    expect(res.status).toBe(200);
    updated = (await res.json()) as any;
    expect(updated).toMatchObject({ revision: 4 });
    expect(updated.thread[0]).toMatchObject({ body: 'Why not?', author: null });
    const snap = await board();
    expect(snap.items.find((i: any) => i.id === item.id).thread).toEqual(updated.thread);
  });

  test('archived cards reject questions and accept comments', async () => {
    const item = await create('Archived thread');
    store.update(dir, item.id, null, { archived: true });
    const cur = await current(item.id);
    const rejected = await post(item.id, { ...cur, entry: { kind: 'question', body: 'Question' } });
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as any).code).toBe('invalid');
    expect((await post(item.id, { ...cur, entry: { kind: 'comment', body: 'Comment' } })).status).toBe(201);
    expect(store.get(dir, item.id).thread.map(e => e.body)).toEqual(['Comment']);
  });

  test('409 on a stale revision or hash; nothing is written', async () => {
    const item = await create('Thread conflict');
    const before = await current(item.id);
    expect((await post(item.id, { ...before, entry: { kind: 'comment', body: 'first' } })).status).toBe(201);
    const stale = await post(item.id, { ...before, entry: { kind: 'comment', body: 'stale' } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).code).toBe('conflict');
    const now = await current(item.id);
    const entryId = store.get(dir, item.id).thread[0].id;
    expect((await patchEntry(item.id, entryId, { revision: now.revision, hash: before.hash, changes: { body: 'x' } })).status).toBe(409);
    expect((await patchEntry(item.id, entryId, { revision: 1, hash: now.hash, changes: { body: 'x' } })).status).toBe(409);
    expect(store.get(dir, item.id).thread.map(e => e.body)).toEqual(['first']);
  });

  test('400 on invalid entries and bodies; thread stays out of the item routes', async () => {
    const item = await create('Thread invalid');
    const cur = await current(item.id);
    const bad = [
      { ...cur, entry: { kind: 'answer', body: 'no question' } },
      { ...cur, entry: { kind: 'question', body: '' } },
      { ...cur, entry: { kind: 'shout', body: 'x' } },
      { ...cur, entry: { kind: 'comment', body: 'x', id: 'TH-000000000001' } },
      { ...cur, entry: { kind: 'comment', body: 'x', author: 'a'.repeat(121) } },
      { ...cur, entry: 'text' },
      { ...cur, entry: { kind: 'comment', body: 'x' }, extra: 1 },
      { revision: cur.revision, entry: { kind: 'comment', body: 'x' } },
    ];
    for (const body of bad) {
      const res = await post(item.id, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(((await res.json()) as any).code).toBe('invalid');
    }
    expect((await post(item.id, '{not json')).status).toBe(400);
    expect((await post(item.id, { ...cur, entry: { kind: 'comment', body: 'x' } }, { ...auth(), 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await post('AB-000000000000', { revision: 1, hash: '0'.repeat(64), entry: { kind: 'comment', body: 'x' } })).status).toBe(400);
    expect((await patchEntry(item.id, 'TH-000000000001', { ...cur, changes: { body: 'x' } })).status).toBe(400);
    expect((await patchEntry(item.id, 'TH-000000000001', { ...cur, changes: { kind: 'question' } })).status).toBe(400);
    expect((await patch(item.id, { ...cur, changes: { thread: [] } })).status).toBe(400);
    expect((await fetch(`${base}/api/items`, { method: 'POST', headers: json(), body: JSON.stringify({ title: 'x', thread: [] }) })).status).toBe(400);
    expect(store.get(dir, item.id).revision).toBe(1);
  });

  test('403 without a valid token, 404 on unknown thread routes', async () => {
    const item = await create('Thread auth');
    const cur = await current(item.id);
    const body = JSON.stringify({ ...cur, entry: { kind: 'comment', body: 'x' } });
    expect((await fetch(`${base}/api/items/${item.id}/thread`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(`${base}/api/items/${item.id}/thread`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(`${base}/api/items/${item.id}/thread`, { method: 'PATCH', headers: json(), body })).status).toBe(404);
    expect((await fetch(`${base}/api/items/${item.id}/thread/TH-1`, { method: 'PATCH', headers: json(), body })).status).toBe(404);
    expect((await fetch(`${base}/api/items/${item.id}/thread/TH-000000000001`, { method: 'POST', headers: json(), body })).status).toBe(404);
    expect((await fetch(`${base}/api/items/${item.id}/thread`, { headers: auth() })).status).toBe(404);
    expect(store.get(dir, item.id).thread).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)('500 io_error when the thread write fails inside the lock', async () => {
    const item = await create('Thread read-only');
    const cur = await current(item.id);
    const file = store.itemPath(dir, item.id);
    const items = dirname(file);
    chmodSync(file, 0o444);
    chmodSync(items, 0o555);
    try {
      const res = await post(item.id, { ...cur, entry: { kind: 'comment', body: 'lost' } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as any).code).toBe('io_error');
    } finally {
      chmodSync(items, 0o755);
      chmodSync(file, 0o644);
    }
    expect(store.get(dir, item.id).thread).toEqual([]);
  });
});

test('feature routes enforce validation, access and conflicts', async () => {
  const post = (body: unknown, headers = json()) => fetch(`${base}/api/features`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await post({ title: 'No token' }, { 'Content-Type': 'application/json' })).status).toBe(403);
  expect((await post({ title: 'Wrong type' }, { ...auth(), 'Content-Type': 'text/plain' })).status).toBe(400);
  expect((await post({ title: '' })).status).toBe(400);
  expect((await post({ title: 'Bad', status: 'unknown' })).status).toBe(400);
  const created = await post({ title: 'Feature bridge' });
  expect(created.status).toBe(201);
  const feature = await created.json() as any;
  const snap = await board();
  expect(snap.features.find((f: any) => f.id === feature.id)).toBeDefined();
  expect(snap.hashes[feature.id]).toBe(store.hashFeature(dir, feature.id));
  const patchFeature = (body: unknown) => fetch(`${base}/api/features/${feature.id}`, { method: 'PATCH', headers: json(), body: JSON.stringify(body) });
  const current = { revision: 1, hash: snap.hashes[feature.id] };
  expect((await patchFeature({ ...current, changes: { unknown: true } })).status).toBe(400);
  expect((await patchFeature({ ...current, changes: { status: 'unknown' } })).status).toBe(400);
  appendFileSync(store.featurePath(dir, feature.id), ' ');
  expect((await patchFeature({ ...current, changes: { title: 'Stale' } })).status).toBe(409);
  const hash = store.hashFeature(dir, feature.id);
  expect((await patchFeature({ revision: 2, hash, changes: { title: 'Stale' } })).status).toBe(409);
  expect((await patchFeature({ revision: 1, hash, changes: { title: 'Updated' } })).status).toBe(200);
  expect((await fetch(`${base}/api/features/nope`, { method: 'PATCH', headers: json(), body: '{}' })).status).toBe(404);
});

test('item routes validate feature links and allow clearing', async () => {
  const feature = store.createFeature(dir, { title: 'Link target' });
  const post = (body: unknown) => fetch(`${base}/api/items`, { method: 'POST', headers: json(), body: JSON.stringify(body) });
  for (const featureValue of [123, 'FT-000000000000']) expect((await post({ title: 'Bad', feature: featureValue })).status).toBe(400);
  expect((await post({ title: 'Bad', thread: [] })).status).toBe(400);
  const response = await post({ title: 'Linked', feature: feature.id });
  expect(response.status).toBe(201);
  const item = await response.json() as any;
  const snap = await board();
  const cur = { revision: item.revision, hash: snap.hashes[item.id] };
  expect((await patch(item.id, { ...cur, changes: { feature: 123 } })).status).toBe(400);
  expect((await patch(item.id, { ...cur, changes: { feature: 'FT-000000000000' } })).status).toBe(400);
  store.updateFeature(dir, feature.id, 1, { archived: true });
  expect((await post({ title: 'Archived', feature: feature.id })).status).toBe(400);
  expect((await patch(item.id, { ...cur, changes: { feature: feature.id } })).status).toBe(400);
  expect((await patch(item.id, { ...cur, changes: { feature: null } })).status).toBe(200);
});
