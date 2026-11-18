import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../../scripts/lib/store';
import { readGraphSettings, saveGraphSettings } from '../../scripts/lib/graph-settings';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('graph settings preserve defaults and reject stale or malformed saves', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-graph-'));
  roots.push(root);
  init(root, 'Graph');
  const initial = readGraphSettings(root);
  expect(initial.hash).toBeNull();
  expect(initial.settings.layout).toBe('compact');
  const saved = saveGraphSettings(root, { ...initial.settings, layout: 'loose', fields: ['field:points'] }, null);
  expect(saved.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(readGraphSettings(root)).toEqual(saved);
  expect(() => saveGraphSettings(root, initial.settings, null)).toThrow('changed');
  expect(() => saveGraphSettings(root, { ...initial.settings, fields: ['field:bad!', 'priority'] }, saved.hash)).toThrow('Invalid');
  expect(readGraphSettings(root)).toEqual(saved);
  writeFileSync(join(root, '.agentboard', 'graph-settings.json'), '{}');
  expect(() => readGraphSettings(root)).toThrow('Invalid');
});
