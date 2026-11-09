import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatJson } from '../../scripts/agentboard';

const root = mkdtempSync(join(tmpdir(), 'agentboard-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cli = (...args: string[]) => Bun.spawnSync(['bun', 'scripts/agentboard.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });

test('JSON serializer: compact form uses ", " and ": " separators and raw non-ASCII', () => {
  const value = { timestamp: '2026-10-31T12:34:56.789Z', unicode: 'é 漢 😀', nested: [[], {}, { quote: '"\\,:' }] };
  expect(formatJson(value)).toBe('{"timestamp": "2026-10-31T12:34:56.789Z", "unicode": "é 漢 😀", "nested": [[], {}, {"quote": "\\"\\\\,:"}]}');
  expect(formatJson(value, 2)).toBe(JSON.stringify(value, null, 2));
});

test('edit changes only supplied fields and reports conflicts', () => {
  expect(cli('init', root).exitCode).toBe(0);
  const created = cli('--root', root, '--json', 'create', 'Original');
  expect(created.exitCode).toBe(0);
  const item = JSON.parse(created.stdout.toString());
  const edited = cli('--root', root, '--json', 'edit', item.id, '--title', 'Updated');
  expect(edited.exitCode).toBe(0);
  expect(JSON.parse(edited.stdout.toString()).title).toBe('Updated');
  const conflicting = cli('--root', root, 'edit', item.id, '--archive', '--unarchive');
  expect(conflicting.exitCode).toBe(1);
  expect(conflicting.stdout.toString()).toBe('');
  expect(conflicting.stderr.toString()).toContain('Error: Conflicting options');
  const stale = cli('--root', root, 'edit', item.id, '--revision', '1', '--title', 'Stale');
  expect(stale.exitCode).toBe(2);
  expect(stale.stdout.toString()).toBe('');
});
