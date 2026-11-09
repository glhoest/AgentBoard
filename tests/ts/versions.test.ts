import { describe, expect, test } from 'bun:test';
import { BoardError } from '../../scripts/lib/types';
import { compareVersions, CURRENT, PIPELINES, readVersion, upgrade, type UpgradeStep } from '../../scripts/lib/versions';

describe('versions', () => {
  test('missing version and the integer 1 read as 1.0.0; semver strings as themselves', () => {
    expect(readVersion(undefined, 'item')).toBe('1.0.0');
    expect(readVersion(1, 'item')).toBe('1.0.0');
    expect(readVersion('1.1.0', 'board')).toBe('1.1.0');
    expect(readVersion('10.20.30', 'board')).toBe('10.20.30');
  });

  test('anything else is an invalid version', () => {
    for (const bad of [2, 1.5, '1', '1.0', 'v1.0.0', '1.0.0-beta', '01.0.0', ' 1.0.0', null, true, {}, []]) {
      expect(() => readVersion(bad, 'item'), JSON.stringify(bad)).toThrow(BoardError);
    }
    expect(() => readVersion('1.0', 'board')).toThrow('board.json has an invalid version: "1.0"');
  });

  test('compare is numeric per part', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });

  test('pipelines are ordered chains ending at CURRENT', () => {
    for (const kind of ['item', 'board'] as const) {
      const steps = PIPELINES[kind];
      for (let i = 1; i < steps.length; i++) expect(steps[i].from).toBe(steps[i - 1].to);
      expect(steps.at(-1)!.to).toBe(CURRENT[kind]);
      for (const step of steps) expect(compareVersions(step.from, step.to)).toBe(-1);
    }
  });

  test('newer versions are rejected loudly, even a newer patch or minor', () => {
    for (const newer of ['1.1.1', '1.2.0', '2.0.0']) {
      expect(() => upgrade('item', { version: newer }), newer).toThrow(`Card format ${newer} was written by a newer AgentBoard`);
      expect(() => upgrade('board', { version: newer }), newer).toThrow('update this copy');
    }
  });

  test('older versions without an upgrade step are rejected', () => {
    expect(() => upgrade('item', { version: '0.9.0' })).toThrow('Card format 0.9.0 is not supported');
    expect(() => upgrade('item', { version: '1.0.5' })).toThrow('not supported');
  });

  test('current files pass through untouched', () => {
    const value = { version: '1.1.0', x: 1 };
    const result = upgrade('item', value);
    expect(result).toEqual({ value, from: '1.1.0', upgraded: false });
    expect(result.value).toBe(value);
  });

  test('card 1.0.0 -> 1.1.0 appends feature and thread, keeps key order and values', () => {
    for (const version of [1, undefined]) {
      const old: any = { id: 'AB-000000000001', revision: 3, archived: false };
      if (version !== undefined) old.version = version;
      const result = upgrade('item', old);
      expect(result.upgraded).toBe(true);
      expect(result.from).toBe('1.0.0');
      expect(Object.keys(result.value)).toEqual(['version', 'id', 'revision', 'archived', 'feature', 'thread']);
      expect(result.value).toEqual({ version: '1.1.0', id: 'AB-000000000001', revision: 3, archived: false, feature: null, thread: [] });
    }
    expect(() => upgrade('item', { version: 1, thread: [] })).toThrow('Invalid item structure or version');
  });

  test('board 1.0.0 -> 1.1.0 inserts needs-grilling after backlog, else first, never twice; adds featureColumns', () => {
    const col = (id: string) => ({ id, name: id });
    const ids = (value: any) => value.columns.map((c: any) => c.id);
    expect(ids(upgrade('board', { version: 1, name: 'b', columns: [col('backlog'), col('todo')] }).value))
      .toEqual(['backlog', 'needs-grilling', 'todo']);
    expect(ids(upgrade('board', { version: 1, name: 'b', columns: [col('todo'), col('backlog'), col('done')] }).value))
      .toEqual(['todo', 'backlog', 'needs-grilling', 'done']);
    expect(ids(upgrade('board', { version: 1, name: 'b', columns: [col('todo'), col('done')] }).value))
      .toEqual(['needs-grilling', 'todo', 'done']);
    expect(ids(upgrade('board', { version: 1, name: 'b', columns: [col('todo'), col('needs-grilling')] }).value))
      .toEqual(['todo', 'needs-grilling']);
    const result = upgrade('board', { version: 1, name: 'b', columns: [col('backlog')] });
    expect(result.value.columns).toEqual([col('backlog'), { id: 'needs-grilling', name: 'Needs grilling' }]);
    expect(result.value.featureColumns).toEqual([{ id: 'planned', name: 'Planned' }, { id: 'active', name: 'Active' }, { id: 'done', name: 'Done' }]);
    expect(Object.keys(result.value)).toEqual(['version', 'name', 'columns', 'featureColumns']);
  });

  test('the pipeline runs several steps in order, so a future major can transform data', () => {
    const steps: UpgradeStep[] = [
      ...PIPELINES.item,
      { from: '1.1.0', to: '1.2.0', upgrade: value => ({ ...value, version: '1.2.0', extra: 'default' }) },
      { from: '1.2.0', to: '2.0.0', upgrade: ({ title, ...rest }) => ({ ...rest, version: '2.0.0', name: title }) },
    ];
    const pipelines = { item: steps, board: PIPELINES.board };
    const result = upgrade('item', { version: 1, title: 'T' }, pipelines, '2.0.0');
    expect(result).toEqual({ value: { version: '2.0.0', feature: null, thread: [], extra: 'default', name: 'T' }, from: '1.0.0', upgraded: true });
    expect(upgrade('item', { version: '1.2.0', title: 'U' }, pipelines, '2.0.0').value.name).toBe('U');
  });

  test('non-objects are rejected', () => {
    for (const bad of [null, [], 'x', 1]) {
      expect(() => upgrade('item', bad)).toThrow('Invalid item structure or version');
      expect(() => upgrade('board', bad)).toThrow('Invalid or unsupported board configuration');
    }
  });
});
