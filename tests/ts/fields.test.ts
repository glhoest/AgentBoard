// Custom card fields: definitions in board.json, values in cards, filters, concurrency, upgrade from 1.1.0, bridge.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/agentboard';
import { startBridge } from '../../scripts/lib/serve';
import * as store from '../../scripts/lib/store';

const CLI = join(import.meta.dir, '..', '..', 'scripts', 'agentboard.ts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-fields-'));
  dirs.push(root);
  store.init(root);
  store.addField(root, { id: 'points', type: 'number', name: 'Story points' });
  store.addField(root, { id: 'team', type: 'text' });
  store.addField(root, { id: 'legal', type: 'boolean' });
  return root;
}

function cli(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(['--root', root, '--quiet', '--json', ...args], { out: t => out.push(t), err: t => err.push(t), env: {} });
  return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) };
}

const ids = (root: string, ...args: string[]): string[] => cli(root, 'list', ...args).json().map((item: any) => item.title).sort();

describe('field definitions', () => {
  test('add, rename, list with usage counts; ids and types are validated', () => {
    const root = project();
    expect(cli(root, 'fields').json()).toEqual([
      { id: 'points', name: 'Story points', type: 'number', cards: 0 },
      { id: 'team', name: 'team', type: 'text', cards: 0 },
      { id: 'legal', name: 'legal', type: 'boolean', cards: 0 },
    ]);
    expect(cli(root, 'field-edit', 'team', '--name', 'Owning team').json().name).toBe('Owning team');
    for (const bad of [['field-add', 'points', '--type', 'text'], ['field-add', 'Bad_Id', '--type', 'text'],
      ['field-add', 'when', '--type', 'date'], ['field-add', 'x'], ['field-edit', 'nope', '--name', 'x'], ['field-edit', 'team']]) {
      expect(cli(root, ...bad).code, bad.join(' ')).toBe(1);
    }
    expect(JSON.parse(readFileSync(store.boardPath(root), 'utf8')).fields).toHaveLength(3);
  });

  test('a field type cannot change, so existing values stay valid', () => {
    const root = project();
    expect(cli(root, 'field-edit', 'points', '--type', 'text').code).toBe(2);
  });

  test('at most 50 fields', () => {
    const root = project();
    for (let i = 0; i < 47; i++) store.addField(root, { id: `f${i}`, type: 'text' });
    expect(() => store.addField(root, { id: 'one-too-many', type: 'text' })).toThrow('at most 50 fields');
  });

  test('removal needs --yes when cards hold values, then strips the values and bumps those cards once', () => {
    const root = project();
    const a = store.create(root, { title: 'A', fields: { points: 3, team: 'x' } });
    const b = store.create(root, { title: 'B', archived: true, fields: { points: 1 } });
    const c = store.create(root, { title: 'C', fields: { team: 'y' } });
    const refused = cli(root, 'field-remove', 'points');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('2 card(s) hold a value for points');
    expect(store.get(root, a.id).fields).toEqual({ points: 3, team: 'x' });
    expect(cli(root, 'field-remove', 'points', '--yes').json().cards.sort()).toEqual([a.id, b.id].sort());
    expect(store.get(root, a.id)).toMatchObject({ revision: 2, fields: { team: 'x' } });
    expect(store.get(root, b.id)).toMatchObject({ revision: 2, fields: {} });
    expect(store.get(root, c.id).revision).toBe(1);
    expect(store.config(root).fields.map(f => f.id)).toEqual(['team', 'legal']);
    expect(cli(root, 'field-remove', 'legal').json().cards).toEqual([]);
  });
});

describe('field values', () => {
  test('create and edit set, replace and clear values; show and list include them', () => {
    const root = project();
    const card = cli(root, 'create', 'Estimate', '--field', 'points=5', '--field', 'team=Platform team').json();
    expect(card.fields).toEqual({ points: 5, team: 'Platform team' });
    const edited = cli(root, 'edit', card.id, '--field', 'legal=true', '--field', 'points=2.5', '--clear-field', 'team').json();
    expect(edited.fields).toEqual({ points: 2.5, legal: true });
    expect(edited.revision).toBe(2);
    expect(cli(root, 'show', card.id).json().fields).toEqual({ points: 2.5, legal: true });
    expect(cli(root, 'list').json()[0].fields).toEqual({ points: 2.5, legal: true });
    // Keys follow definition order, whatever the order of edits.
    expect(Object.keys(store.get(root, card.id).fields)).toEqual(['points', 'legal']);
  });

  test('values are checked against the field type', () => {
    const root = project();
    const card = store.create(root, { title: 'T' });
    for (const args of [['points=abc'], ['points='], ['points=1,5'], ['points=Infinity'], ['legal=yes'], ['legal=TRUE'], ['team='], ['nope=1'], ['points']]) {
      const result = cli(root, 'edit', card.id, '--field', args[0]);
      expect(result.code, args[0]).toBe(1);
    }
    expect(cli(root, 'edit', card.id, '--clear-field', 'nope').code).toBe(1);
    expect(cli(root, 'edit', card.id, '--field', 'points=1', '--clear-field', 'points').code).toBe(1);
    expect(store.get(root, card.id).revision).toBe(1);
    expect(cli(root, 'edit', card.id, '--field', 'points=-1e2').json().fields).toEqual({ points: -100 });
    expect(cli(root, 'edit', card.id, '--field', `team=${'x'.repeat(1001)}`).code).toBe(1);
  });

  test('a card file with an unknown or mistyped value is rejected', () => {
    const root = project();
    const card = store.create(root, { title: 'T' });
    for (const bad of [{ nope: 1 }, { points: '5' }, { legal: 1 }, { team: '' }, [], null]) {
      const file = JSON.parse(readFileSync(store.itemPath(root, card.id), 'utf8'));
      file.fields = bad;
      writeFileSync(store.itemPath(root, card.id), JSON.stringify(file, null, 2) + '\n');
      expect(() => store.get(root, card.id), JSON.stringify(bad)).toThrow();
    }
  });

  test('concurrent field edits to one card serialize without losing values', async () => {
    const root = project();
    const card = store.create(root, { title: 'T' });
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['bun', CLI, '--root', root, '--quiet', '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
      return { code: await p.exited, err: await new Response(p.stderr).text() };
    };
    const results = await Promise.all([
      run('edit', card.id, '--field', 'points=8'), run('edit', card.id, '--field', 'team=Core'), run('edit', card.id, '--field', 'legal=false'),
    ]);
    expect(results.map(r => r.code), results.map(r => r.err).join('|')).toEqual([0, 0, 0]);
    expect(store.get(root, card.id)).toMatchObject({ revision: 4, fields: { points: 8, team: 'Core', legal: false } });
  });

  test('--revision guards field edits like any other edit', () => {
    const root = project();
    const card = store.create(root, { title: 'T' });
    expect(cli(root, 'edit', card.id, '--revision', '1', '--field', 'points=1').code).toBe(0);
    expect(cli(root, 'edit', card.id, '--revision', '1', '--field', 'points=2').code).toBe(2);
    expect(store.get(root, card.id).fields.points).toBe(1);
  });
});

describe('list filters', () => {
  function board() {
    const root = project();
    store.create(root, { title: 'small', fields: { points: 2, team: 'Web', legal: false } });
    store.create(root, { title: 'five', fields: { points: 5, team: 'Platform' } });
    store.create(root, { title: 'five-b', fields: { points: 5, legal: true } });
    store.create(root, { title: 'eight', fields: { points: 8, team: 'platform ops' } });
    store.create(root, { title: 'unestimated' });
    store.create(root, { title: 'hidden', archived: true, fields: { points: 5 } });
    return root;
  }

  test('exact match: numeric for numbers, whole-value and case-sensitive for text, true/false for booleans', () => {
    const root = board();
    expect(ids(root, '--field', 'points=5')).toEqual(['five', 'five-b']);
    expect(ids(root, '--field', 'points=5.0')).toEqual(['five', 'five-b']);
    expect(ids(root, '--field', 'points=05')).toEqual(['five', 'five-b']);
    expect(ids(root, '--field', 'team=Platform')).toEqual(['five']);
    expect(ids(root, '--field', 'team=platform')).toEqual([]);
    expect(ids(root, '--field', 'legal=false')).toEqual(['small']);
    expect(ids(root, '--field', 'legal=true')).toEqual(['five-b']);
  });

  test('min and max are inclusive and combine into ranges; cards without a value never match', () => {
    const root = board();
    expect(ids(root, '--field-min', 'points=5')).toEqual(['eight', 'five', 'five-b']);
    expect(ids(root, '--field-max', 'points=5')).toEqual(['five', 'five-b', 'small']);
    expect(ids(root, '--field-min', 'points=3', '--field-max', 'points=5')).toEqual(['five', 'five-b']);
    expect(ids(root, '--field-min', 'points=-1')).toEqual(['eight', 'five', 'five-b', 'small']);
  });

  test('contains is a case-insensitive substring search on text fields', () => {
    const root = board();
    expect(ids(root, '--field-contains', 'team=PLAT')).toEqual(['eight', 'five']);
    expect(ids(root, '--field-contains', 'team=ops')).toEqual(['eight']);
  });

  test('has and no select by presence; filters combine with each other, other options and --all', () => {
    const root = board();
    expect(ids(root, '--no-field', 'points')).toEqual(['unestimated']);
    expect(ids(root, '--has-field', 'team')).toEqual(['eight', 'five', 'small']);
    expect(ids(root, '--field-min', 'points=5', '--has-field', 'team')).toEqual(['eight', 'five']);
    expect(ids(root, '--field', 'points=5', '--all')).toEqual(['five', 'five-b', 'hidden']);
    expect(ids(root, '--field', 'points=5', '--status', 'done')).toEqual([]);
  });

  test('misuse is an error', () => {
    const root = board();
    for (const args of [['--field', 'nope=1'], ['--field', 'points=abc'], ['--field', 'points'], ['--field-min', 'team=1'],
      ['--field-max', 'legal=true'], ['--field-contains', 'points=5'], ['--field-contains', 'team='], ['--has-field', 'nope']]) {
      expect(cli(root, 'list', ...args).code, args.join(' ')).toBe(1);
    }
  });

  test('--field is not mistaken for its longer siblings', () => {
    const root = board();
    expect(ids(root, '--field=points=8')).toEqual(['eight']);
    expect(cli(root, 'list', '--field-m', 'points=8').code).toBe(2); // ambiguous prefix of --field-min / --field-max
  });
});

describe('upgrade from 1.1.0', () => {
  test('a 1.1.0 board and cards gain empty fields on first read and keep revision and updatedAt', () => {
    const root = project();
    const card = store.create(root, { title: 'Old' });
    const board = JSON.parse(readFileSync(store.boardPath(root), 'utf8'));
    const item = JSON.parse(readFileSync(store.itemPath(root, card.id), 'utf8'));
    const { fields: _b, ...oldBoard } = board;
    const { fields: _i, ...oldItem } = item;
    writeFileSync(store.boardPath(root), JSON.stringify({ ...oldBoard, version: '1.1.0' }, null, 2) + '\n');
    writeFileSync(store.itemPath(root, card.id), JSON.stringify({ ...oldItem, version: '1.1.0' }, null, 2) + '\n');
    const shown = cli(root, 'show', card.id).json();
    expect(shown).toEqual({ ...item, fields: {} });
    expect(JSON.parse(readFileSync(store.boardPath(root), 'utf8'))).toMatchObject({ version: '1.2.0', fields: [] });
    expect(readFileSync(store.itemPath(root, card.id), 'utf8')).toContain('"fields": {}');
    expect(readdirSync(join(root, '.agentboard', 'items'))).toEqual([`${card.id}.json`]);
  });
});

describe('bridge', () => {
  test('PATCH replaces the values, validates them, and POST creates a card with values', async () => {
    const root = project();
    const ui = join(root, 'ui.html');
    writeFileSync(ui, '<p>ui</p>');
    const bridge = startBridge(root, 0, ui, () => {});
    const base = `http://127.0.0.1:${bridge.port}`;
    const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
    try {
      const created = await fetch(`${base}/api/items`, { method: 'POST', headers, body: JSON.stringify({ title: 'T', fields: { points: 3 } }) });
      expect(created.status).toBe(201);
      const card = (await created.json()) as any;
      expect(card.fields).toEqual({ points: 3 });
      const snap = (await (await fetch(`${base}/api/board`, { headers })).json()) as any;
      expect(snap.config.fields.map((f: any) => f.id)).toEqual(['points', 'team', 'legal']);
      const patch = (changes: unknown, revision = card.revision) => fetch(`${base}/api/items/${card.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ revision, hash: snap.hashes[card.id], changes }),
      });
      const bad = await patch({ fields: { points: 'x' } });
      expect(bad.status).toBe(400);
      const ok = await patch({ fields: { team: 'Web', points: 8 } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).fields).toEqual({ points: 8, team: 'Web' });
    } finally {
      bridge.stop();
    }
  });
});
